import { useEffect, useRef, useState } from 'react';
import {
  addCard,
  type BoardCard,
  type BoardData,
  cardsIn,
  duplicateCard,
  moveCard,
  removeCard,
  STAGES,
  type Stage,
  updateCard,
} from '../../src/board';
import { badgeStateForCard, type CardBadge } from '../../src/board-linkage';
import { type BoardDiff, diffBoard } from '../../src/conduit-proposal';
import { emptyBoardData } from '../../src/conduit-store';
import {
  CANONICAL_TRANSITIONS,
  emptyPipelineConfig,
  type PipelineConfig,
  setTransitionSkill,
  skillForTransition,
} from '../../src/pipeline';
import type { QueueSummary } from '../../src/queue-summary';
import { safeSpecFileName } from '../../src/spec-path';
import type { Session } from '../../src/types';
import { post, subscribe } from '../bridge';
import {
  IconChevron,
  IconDoc,
  IconDuplicate,
  IconPencil,
  IconPlus,
  IconTerminal,
  IconTrash,
} from '../icons';
import { relativeTime } from '../relative-time';
import { useDebouncedFlush } from '../use-debounced-flush';
import { useEscapeKey } from '../use-escape-key';
import { ContextMenu, type MenuState } from './context-menu';
import { BoardProposalBanner } from './proposal-banner';

export function BoardView({
  projectPath,
  sessions = [],
  onStartSessionForCard,
  onActivateSession,
  onClose,
}: {
  projectPath?: string;
  /** Live session list — a card's badge is derived by matching `session.cardId` (N2). */
  sessions?: Session[];
  /** Open the prefilled new-session flow for this card's project, stamping the card id. */
  onStartSessionForCard?: (card: BoardCard) => void;
  /** Activate (focus) the linked session when the card's status badge is clicked. */
  onActivateSession?: (sessionId: string) => void;
  onClose: () => void;
}) {
  // The board is per-project (`<projectPath>/.conduit/board.json`). With no project open
  // there is nowhere to persist, so it starts empty (never Conduit's own seed backlog).
  const [board, setBoard] = useState<BoardData>(() => emptyBoardData());
  const dragCard = useRef<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Card ids with a spec on disk (`.conduit/specs/<id>.md`) — drives the indicator.
  const [specCardIds, setSpecCardIds] = useState<Set<string>>(() => new Set());
  const [specCard, setSpecCard] = useState<BoardCard | null>(null);
  const [pipeline, setPipeline] = useState<PipelineConfig>(() => emptyPipelineConfig());
  const [pipelineOpen, setPipelineOpen] = useState(false);
  // A pending agent board proposal (N1), or null. Diffed against the live `board`.
  const [proposalDiff, setProposalDiff] = useState<BoardDiff | null>(null);
  const [queueSummary, setQueueSummary] = useState<QueueSummary | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cards register a "start renaming" callback so the context menu's Rename item can
  // focus a card's inline title edit by id.
  const renamers = useRef(new Map<string, () => void>());

  // Latest board/pipeline so debounce-flush closures see fresh data even when they fire
  // after a React state update cycle.
  const boardRef = useRef(board);
  boardRef.current = board;
  const pipeRef = useRef(pipeline);
  pipeRef.current = pipeline;

  // Debounced saves that flush on unmount — prevents data loss on quick-close (Escape).
  const { schedule: scheduleBoardSave, cancel: cancelBoardSave } = useDebouncedFlush(() => {
    if (projectPath) post({ type: 'updateBoard', path: projectPath, board: boardRef.current });
  }, 300);

  const { schedule: schedulePipeSave } = useDebouncedFlush(() => {
    if (projectPath) post({ type: 'updatePipeline', path: projectPath, config: pipeRef.current });
  }, 300);

  // Display timer, not a save — so not debounce-flushed.
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (projectPath) {
      post({ type: 'requestBoard', path: projectPath });
      post({ type: 'requestPipeline', path: projectPath });
    } else {
      setBoard(emptyBoardData());
      setSpecCardIds(new Set());
      setPipeline(emptyPipelineConfig());
      setQueueSummary(null);
    }
    return subscribe((msg) => {
      // Only replies for the current project (a reply may be the initial load OR a live
      // external edit the host pushed when an agent advanced a card on disk).
      if (msg.type === 'board' && msg.path === projectPath) {
        // Cancel any pending local save so we don't overwrite the agent's change with a
        // stale in-flight edit — external truth wins for "agent advances cards".
        cancelBoardSave();
        setBoard(msg.board);
        boardRef.current = msg.board;
      }
      if (msg.type === 'specsList' && msg.path === projectPath) {
        setSpecCardIds(new Set(msg.cardIds));
      }
      if (msg.type === 'pipeline' && msg.path === projectPath) {
        setPipeline(msg.config);
      }
      // Diff against the live board so the banner reads in human terms; `null` = no proposal.
      if (msg.type === 'proposal' && msg.kind === 'board' && msg.path === projectPath) {
        setProposalDiff(msg.proposed ? diffBoard(boardRef.current, msg.proposed) : null);
      }
      if (msg.type === 'pipelineQueue' && msg.path === projectPath) {
        setQueueSummary(msg.summary);
      }
    });
  }, [projectPath, cancelBoardSave]);

  // Close the board on Escape — but NOT while the spec editor, Pipeline panel, or queue
  // popover is open, or one Escape would close both the overlay and the board behind it.
  // Each overlay owns Escape (its own useEscapeKey) while mounted.
  useEscapeKey(() => {
    if (!specCard && !pipelineOpen && !queueOpen) onClose();
  });

  // specsList carries SANITIZED filename stems; derive the same stem so a card with a
  // hostile/odd id still matches its spec.
  const cardHasSpec = (card: BoardCard) => specCardIds.has(safeSpecFileName(card.id));

  const apply = (next: BoardData) => {
    setBoard(next);
    boardRef.current = next;
    if (!projectPath) return; // no project => nowhere to persist
    scheduleBoardSave();
  };

  const savePipeline = (next: PipelineConfig) => {
    setPipeline(next);
    pipeRef.current = next;
    if (!projectPath) return;
    schedulePipeSave();
  };

  const showToast = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  };

  // Move a card AND surface the configured pipeline skill for that (from → to)
  // transition. SURFACE only — a toast + a record to `.conduit/pipeline-queue.json` (an
  // external agent runs it; Conduit can't). A same-column move never surfaces; the move
  // itself is never blocked.
  const moveAndSurface = (card: BoardCard, to: Stage) => {
    const from = card.stage;
    apply(moveCard(board, card.id, to));
    if (from === to) return;
    const skill = skillForTransition(pipeline, from, to);
    if (!skill) return;
    const toLabel = STAGES.find((s) => s.id === to)?.label ?? to;
    showToast(`Moving to ${toLabel} → run \`${skill}\``);
    if (projectPath) {
      post({
        type: 'queueTransition',
        path: projectPath,
        cardId: card.id,
        cardTitle: card.title,
        from,
        to,
        skill,
      });
    }
  };

  const onCardContextMenu = (e: React.MouseEvent, card: BoardCard) => {
    e.preventDefault();
    e.stopPropagation();
    const moveItems = STAGES.filter((s) => s.id !== card.stage).map((s, i) => {
      const skill = skillForTransition(pipeline, card.stage, s.id);
      return {
        // Hint the configured skill inline so the pipeline is visible at the point of action.
        label: skill ? `Move to ${s.label}  ·  ${skill}` : `Move to ${s.label}`,
        icon: <IconChevron size={13} />,
        separatorBefore: i === 0,
        onClick: () => moveAndSurface(card, s.id),
      };
    });
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Rename…',
          icon: <IconPencil size={13} />,
          onClick: () => renamers.current.get(card.id)?.(),
        },
        {
          label: 'Duplicate',
          icon: <IconDuplicate size={13} />,
          onClick: () => apply(duplicateCard(board, card.id)),
        },
        // N2: opens the prefilled new-session flow and stamps this card id on the session.
        {
          label: 'Start session for this card',
          icon: <IconTerminal size={13} />,
          separatorBefore: true,
          disabled: !projectPath || !onStartSessionForCard,
          onClick: () => onStartSessionForCard?.(card),
        },
        {
          label: cardHasSpec(card) ? 'Edit spec…' : 'Add spec…',
          icon: <IconDoc size={13} />,
          separatorBefore: true,
          onClick: () => setSpecCard(card),
        },
        ...moveItems,
        {
          label: 'Delete',
          icon: <IconTrash size={13} />,
          danger: true,
          separatorBefore: true,
          onClick: () => apply(removeCard(board, card.id)),
        },
      ],
    });
  };

  const onColumnContextMenu = (e: React.MouseEvent, stage: Stage) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Add card',
          icon: <IconPlus size={13} />,
          onClick: () => apply(addCard(board, stage, 'New card')),
        },
      ],
    });
  };

  return (
    <div className="board">
      <div className="board__head">
        <span className="board__title">Feature board</span>
        <span className="board__sub">
          Shared with the overnight agent · drag cards between columns
        </span>
        {/* N3: proposal-pending badge — visible when a board proposal awaits review. */}
        {proposalDiff && (
          <span
            className="board__proposal-badge"
            title="A board proposal is pending review"
            aria-label="Board proposal pending"
          >
            Proposal pending
          </span>
        )}
        {/* N3: pipeline queue depth badge + popover. Only shown when queue has entries. */}
        {queueSummary && queueSummary.depth > 0 && (
          <div className="board__queue-wrap">
            <button
              className={`board__queue-btn ${queueOpen ? 'board__queue-btn--on' : ''}`}
              onClick={() => setQueueOpen((o) => !o)}
              title={`${queueSummary.depth} transition${queueSummary.depth === 1 ? '' : 's'} queued for an agent`}
              aria-label={`Pipeline queue: ${queueSummary.depth} entries`}
            >
              <span className="board__queue-dot" />
              Queue {queueSummary.depth}
            </button>
            {queueOpen && (
              <>
                {/* Transparent full-screen backdrop for click-outside to close. */}
                <div className="queuebackdrop" onMouseDown={() => setQueueOpen(false)} />
                <QueuePopover summary={queueSummary} onClose={() => setQueueOpen(false)} />
              </>
            )}
          </div>
        )}
        <button
          className={`board__pipeline-btn ${pipelineOpen ? 'board__pipeline-btn--on' : ''}`}
          onClick={() => setPipelineOpen((o) => !o)}
          title="Configure which skill runs on each column transition"
        >
          Pipeline
        </button>
      </div>
      {proposalDiff && projectPath && (
        <BoardProposalBanner
          diff={proposalDiff}
          onAccept={() => {
            post({ type: 'acceptProposal', path: projectPath, kind: 'board' });
            setProposalDiff(null);
          }}
          onReject={() => {
            post({ type: 'rejectProposal', path: projectPath, kind: 'board' });
            setProposalDiff(null);
          }}
        />
      )}
      <div className="board__cols">
        {STAGES.map((stage) => {
          const cards = cardsIn(board, stage.id);
          return (
            <div
              key={stage.id}
              className={`bcol ${overStage === stage.id ? 'bcol--over' : ''}`}
              onContextMenu={(e) => onColumnContextMenu(e, stage.id)}
              onDragOver={(e) => {
                if (dragCard.current) {
                  e.preventDefault();
                  setOverStage(stage.id);
                }
              }}
              onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragCard.current) {
                  const dropped = board.cards.find((c) => c.id === dragCard.current);
                  if (dropped) moveAndSurface(dropped, stage.id);
                }
                dragCard.current = null;
                setOverStage(null);
              }}
            >
              <div className="bcol__head">
                <span className="bcol__title">{stage.label}</span>
                <span className="bcol__count">{cards.length}</span>
              </div>
              <div className="bcol__cards">
                {cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    hasSpec={cardHasSpec(card)}
                    badge={badgeStateForCard(sessions, card.id)}
                    onActivateSession={onActivateSession}
                    onOpenSpec={() => setSpecCard(card)}
                    onDragStart={() => {
                      dragCard.current = card.id;
                    }}
                    onDragEnd={() => {
                      dragCard.current = null;
                      setOverStage(null);
                    }}
                    onEdit={(patch) => apply(updateCard(board, card.id, patch))}
                    onDuplicate={() => apply(duplicateCard(board, card.id))}
                    onDelete={() => apply(removeCard(board, card.id))}
                    onContextMenu={(e) => onCardContextMenu(e, card)}
                    registerRename={(fn) => {
                      if (fn) renamers.current.set(card.id, fn);
                      else renamers.current.delete(card.id);
                    }}
                  />
                ))}
              </div>
              <AddCard onAdd={(title) => apply(addCard(board, stage.id, title))} />
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {specCard && projectPath && (
        <SpecEditor projectPath={projectPath} card={specCard} onClose={() => setSpecCard(null)} />
      )}
      {pipelineOpen && (
        <PipelinePanel
          config={pipeline}
          onChange={savePipeline}
          onClose={() => setPipelineOpen(false)}
        />
      )}
      {toast && (
        <div className="board__toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}

/**
 * Configure the pipeline (G4): a free-text skill name per canonical column transition
 * (no skill registry — the agent/CLI owns that). Conduit surfaces + records the skill on
 * a card move; it does NOT execute it. An external agent drains the pipeline queue.
 */
function PipelinePanel({
  config,
  onChange,
  onClose,
}: {
  config: PipelineConfig;
  onChange: (next: PipelineConfig) => void;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  return (
    <div className="pipeoverlay" onMouseDown={onClose}>
      <div
        className="pipepanel"
        role="dialog"
        aria-modal="true"
        aria-label="Pipeline configuration"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pipepanel__head">
          <span className="pipepanel__title">Pipeline</span>
          <span className="pipepanel__sub">A skill for each column transition</span>
        </div>
        <div className="pipepanel__rows">
          {CANONICAL_TRANSITIONS.map((t) => {
            const value = skillForTransition(config, t.from, t.to) ?? '';
            return (
              <label className="pipepanel__row" key={`${t.from}->${t.to}`}>
                <span className="pipepanel__label">{t.label}</span>
                <input
                  className="pipepanel__input"
                  spellCheck={false}
                  placeholder="skill name (e.g. writing-plans)"
                  defaultValue={value}
                  onBlur={(e) => {
                    const next = setTransitionSkill(config, t.from, t.to, e.target.value);
                    if (
                      skillForTransition(next, t.from, t.to) !==
                      skillForTransition(config, t.from, t.to)
                    )
                      onChange(next);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
              </label>
            );
          })}
        </div>
        <p className="pipepanel__note">
          Conduit <strong>surfaces</strong> the skill on a card move and records it to{' '}
          <code>.conduit/pipeline-queue.json</code> for an agent (or you) to run — it does not
          execute skills itself.
        </p>
        <div className="pipepanel__acts">
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A card's spec editor (G3). Loads/saves `.conduit/specs/<card-id>.md` via the host. An
 * absent spec is seeded with a `# <title>` heading so the first Save creates the file.
 */
function SpecEditor({
  projectPath,
  card,
  onClose,
}: {
  projectPath: string;
  card: BoardCard;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // In a ref so a live external rename (agent-advances-cards flow) can't re-fire the load
  // effect and clobber unsaved edits. Used only to seed a heading for an ABSENT spec.
  const titleRef = useRef(card.title);
  titleRef.current = card.title;

  // Load once per (project, card). Title intentionally NOT a dependency.
  useEffect(() => {
    post({ type: 'requestSpec', path: projectPath, cardId: card.id });
    return subscribe((msg) => {
      if (msg.type === 'spec' && msg.path === projectPath && msg.cardId === card.id) {
        // `exists` distinguishes an absent file from an intentionally-empty one.
        setText(msg.exists ? msg.content : `# ${titleRef.current}\n\n`);
        setLoaded(true);
      }
    });
  }, [projectPath, card.id]);

  useEscapeKey(onClose);

  const save = () => {
    if (saving) return; // guard a double-fire (e.g. Cmd/Ctrl+Enter auto-repeat)
    setSaving(true);
    post({ type: 'saveSpec', path: projectPath, cardId: card.id, content: text });
    // Host persists + re-emits specsList and surfaces any failure (ADR §5). Close optimistically.
    onClose();
  };

  return (
    <div className="specoverlay" onMouseDown={onClose}>
      <div
        className="specmodal"
        role="dialog"
        aria-modal="true"
        aria-label={`Spec for ${card.title}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="specmodal__head">
          <IconDoc size={14} />
          <span className="specmodal__title">{card.title}</span>
          <span className="specmodal__path">.conduit/specs/{card.id}.md</span>
        </div>
        <textarea
          className="specmodal__editor"
          autoFocus
          spellCheck={false}
          placeholder={loaded ? '' : 'Loading spec…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter saves; Escape is handled by useEscapeKey.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
          }}
        />
        <div className="specmodal__acts">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!loaded || saving} onClick={save}>
            Save spec
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({
  card,
  hasSpec,
  badge,
  onActivateSession,
  onOpenSpec,
  onDragStart,
  onDragEnd,
  onEdit,
  onDuplicate,
  onDelete,
  onContextMenu,
  registerRename,
}: {
  card: BoardCard;
  /** True when the card has a spec on disk (`.conduit/specs/<id>.md`). */
  hasSpec: boolean;
  /** The linked-session status badge (N2), or null when no session links to this card. */
  badge: CardBadge | null;
  /** Activate the linked session when the badge is clicked. */
  onActivateSession?: (sessionId: string) => void;
  /** Open the card's spec editor. */
  onOpenSpec: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onEdit: (patch: Partial<Omit<BoardCard, 'id'>>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Register (or clear) a callback the board menu uses to start a title rename. */
  registerRename: (fn: (() => void) | null) => void;
}) {
  const [editing, setEditing] = useState<null | 'title' | 'notes'>(null);
  const [draft, setDraft] = useState('');
  const begin = (field: 'title' | 'notes') => {
    setDraft(card[field] ?? '');
    setEditing(field);
  };

  // Expose "start renaming the title" to the parent board's context menu.
  useEffect(() => {
    registerRename(() => begin('title'));
    return () => registerRename(null);
  });
  const commit = () => {
    if (editing) onEdit({ [editing]: draft } as Partial<BoardCard>);
    setEditing(null);
  };

  return (
    <div
      className="bcard"
      draggable={!editing}
      onContextMenu={onContextMenu}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      {editing === 'title' ? (
        <input
          className="bcard__edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(null);
          }}
        />
      ) : (
        <div className="bcard__title" onDoubleClick={() => begin('title')}>
          {hasSpec && (
            <span
              className="bcard__spec"
              title="Has a spec — .conduit/specs/"
              aria-label="Has a spec"
            >
              <IconDoc size={11} />
            </span>
          )}
          {card.title}
        </div>
      )}
      {badge && (
        <button
          type="button"
          className={`bcard__badge bcard__badge--${badge.status}`}
          title={
            badge.status === 'running'
              ? 'Linked session is running — click to focus it'
              : 'Linked session has exited — click to focus it'
          }
          aria-label={`Linked session ${badge.status}. Click to focus.`}
          onClick={(e) => {
            e.stopPropagation();
            onActivateSession?.(badge.sessionId);
          }}
        >
          <span className="bcard__badge-dot" />
          <IconTerminal size={11} />
          <span className="bcard__badge-label">
            {badge.status === 'running' ? 'Running' : 'Exited'}
            {badge.count > 1 ? ` · ${badge.count}` : ''}
          </span>
        </button>
      )}
      {editing === 'notes' ? (
        <textarea
          className="bcard__edit bcard__edit--notes"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(null);
          }}
        />
      ) : card.notes ? (
        <div className="bcard__notes" onDoubleClick={() => begin('notes')}>
          {card.notes}
        </div>
      ) : (
        <div className="bcard__notes bcard__notes--empty" onDoubleClick={() => begin('notes')}>
          Add notes…
        </div>
      )}
      <CardMeta createdAt={card.createdAt} updatedAt={card.updatedAt} />
      <div className="bcard__acts">
        <button
          className={`bcard__act ${hasSpec ? 'bcard__act--on' : ''}`}
          aria-label={hasSpec ? 'Edit spec' : 'Add spec'}
          onClick={(e) => {
            e.stopPropagation();
            onOpenSpec();
          }}
        >
          <IconDoc size={12} />
        </button>
        <button
          className="bcard__act"
          aria-label="Duplicate card"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
        >
          <IconDuplicate size={12} />
        </button>
        <button
          className="bcard__act bcard__act--del"
          aria-label="Delete card"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <IconTrash size={12} />
        </button>
      </div>
    </div>
  );
}

function CardMeta({ createdAt, updatedAt }: { createdAt?: number; updatedAt?: number }) {
  const parts: string[] = [];
  if (typeof createdAt === 'number') parts.push(`created ${relativeTime(createdAt)}`);
  if (typeof updatedAt === 'number') parts.push(`updated ${relativeTime(updatedAt)}`);
  if (parts.length === 0) return null;
  return <div className="bcard__meta">{parts.join(' · ')}</div>;
}

function AddCard({ onAdd }: { onAdd: (title: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const commit = () => {
    if (text.trim()) onAdd(text.trim());
    setText('');
    setAdding(false);
  };
  if (!adding)
    return (
      <button className="bcol__add" onClick={() => setAdding(true)}>
        <IconPlus size={12} /> Add card
      </button>
    );
  return (
    <input
      className="bcard__edit"
      autoFocus
      placeholder="Card title…"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          setText('');
          setAdding(false);
        }
      }}
    />
  );
}

/**
 * N3: Pipeline queue popover (card titles, transitions, skills, times). Closes on Escape
 * or outside click (backdrop rendered by the parent); positioned under the queue button.
 */
function QueuePopover({ summary, onClose }: { summary: QueueSummary; onClose: () => void }) {
  useEscapeKey(onClose);
  return (
    <div className="queuepopover" role="dialog" aria-modal="true" aria-label="Pipeline queue">
      <div className="queuepopover__head">
        <span className="queuepopover__title">Pipeline queue</span>
        <span className="queuepopover__count">{summary.depth} pending</span>
      </div>
      <div className="queuepopover__rows">
        {summary.recent.map((entry) => (
          <div className="queuepopover__row" key={entry.id}>
            <div className="queuepopover__card">{entry.cardTitle}</div>
            <div className="queuepopover__meta">
              <span className="queuepopover__transition">
                {entry.from} → {entry.to}
              </span>
              <span className="queuepopover__skill">{entry.skill}</span>
              <span className="queuepopover__time">{relativeTime(entry.at)}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="queuepopover__note">
        An external agent drains <code>.conduit/pipeline-queue.json</code>
      </p>
    </div>
  );
}
