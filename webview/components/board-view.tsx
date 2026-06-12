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
  // Card ids that have a spec on disk (`.conduit/specs/<id>.md`) — drives the indicator.
  const [specCardIds, setSpecCardIds] = useState<Set<string>>(() => new Set());
  // The card whose spec is open in the editor overlay (null = closed).
  const [specCard, setSpecCard] = useState<BoardCard | null>(null);
  // The per-transition → skill pipeline config (G4). Drives the on-move surfacing.
  const [pipeline, setPipeline] = useState<PipelineConfig>(() => emptyPipelineConfig());
  // Whether the Pipeline config panel is open.
  const [pipelineOpen, setPipelineOpen] = useState(false);
  // A pending agent proposal for this board (N1), or null when none. The diff is computed
  // against the live `board`. The human accepts (host applies + deletes) or rejects.
  const [proposalDiff, setProposalDiff] = useState<BoardDiff | null>(null);
  // N3: pipeline queue summary — depth badge + popover entries in the board header.
  const [queueSummary, setQueueSummary] = useState<QueueSummary | null>(null);
  // Whether the pipeline queue popover is open.
  const [queueOpen, setQueueOpen] = useState(false);
  // The current on-move toast ("Moving to Building → run `writing-plans`"), or null.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cards register a "start renaming" callback here so the context menu's
  // Rename item can focus a card's existing inline title edit by id.
  const renamers = useRef(new Map<string, () => void>());

  // Refs holding the latest board/pipeline so debounce-flush closures always
  // see fresh data even if they fire after a React state update cycle.
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

  // Only the toast timer is not debounced-flushed (it's a display timer, not a save).
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
      // Accept only board replies for the current project (ignore stale ones for a
      // previous project). A reply may be the initial load OR a live external edit the
      // host pushed because an agent advanced a card on disk.
      if (msg.type === 'board' && msg.path === projectPath) {
        // A live external update arrived: cancel any pending local save so we don't
        // immediately overwrite the agent's change with our stale in-flight edit —
        // external truth wins for the "agent advances cards" story.
        cancelBoardSave();
        setBoard(msg.board);
        boardRef.current = msg.board;
      }
      // The host's set of cards-with-a-spec (sent with the board + after each save).
      if (msg.type === 'specsList' && msg.path === projectPath) {
        setSpecCardIds(new Set(msg.cardIds));
      }
      // The per-project pipeline config (skill per column transition).
      if (msg.type === 'pipeline' && msg.path === projectPath) {
        setPipeline(msg.config);
      }
      // An agent proposal (N1) arrived or cleared. Diff it against the live board so the
      // banner reads in human terms; `null` proposed = no pending proposal (banner hidden).
      if (msg.type === 'proposal' && msg.kind === 'board' && msg.path === projectPath) {
        setProposalDiff(msg.proposed ? diffBoard(boardRef.current, msg.proposed) : null);
      }
      // N3: pipeline queue summary — depth badge + popover entries.
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

  // The host's specsList carries SANITIZED filename stems; derive the same stem from the
  // card id so a card whose id needed sanitizing (hostile/odd id) still matches its spec.
  const cardHasSpec = (card: BoardCard) => specCardIds.has(safeSpecFileName(card.id));

  const apply = (next: BoardData) => {
    setBoard(next);
    boardRef.current = next;
    if (!projectPath) return; // no project => nowhere to persist
    scheduleBoardSave();
  };

  // Persist the pipeline config (debounced), like the board save.
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

  // Move a card AND surface the pipeline skill, if one is configured for that exact
  // (from → to) transition. SURFACE only — a toast + a machine-readable record to
  // `.conduit/pipeline-queue.json` (an external agent runs the skill; Conduit can't).
  // A no-op move (same column) never surfaces. The move itself is never blocked.
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

  // Right-click a card: app-styled menu wired to existing board ops.
  const onCardContextMenu = (e: React.MouseEvent, card: BoardCard) => {
    e.preventDefault();
    e.stopPropagation();
    const moveItems = STAGES.filter((s) => s.id !== card.stage).map((s, i) => {
      const skill = skillForTransition(pipeline, card.stage, s.id);
      return {
        // When a skill is configured for this transition, hint it inline so the
        // pipeline is visible at the point of action (not just in the panel).
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
        // N2: link real work to the card — opens the prefilled new-session flow in the
        // board's project and stamps this card id on the created session.
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

  // Right-click the blank column area: add a card to that stage.
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
 * Configure the pipeline (G4): assign a Claude Code skill name to each canonical column
 * transition. Free-text skill names — the app has no skill registry; the agent/CLI owns
 * that. HONEST BOUNDARY (stated in the panel): Conduit surfaces + records the skill on a
 * card move; it does NOT execute it. An external agent drains `.conduit/pipeline-queue.json`.
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
 * A card's spec editor (G3). Loads `.conduit/specs/<card-id>.md` via the host, lets the
 * user edit the Markdown in a plain textarea, and saves it back. When no spec exists yet
 * the editor seeds a `# <title>` heading so the first Save creates the file. The has-spec
 * indicator updates from the host's `specsList` re-emit after a successful save.
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
  // The title is only used to seed a heading for an ABSENT spec; capture it in a ref so a
  // live external rename of the card (the documented agent-advances-cards flow) can't
  // re-fire the load effect and clobber the user's in-progress unsaved edits.
  const titleRef = useRef(card.title);
  titleRef.current = card.title;

  // Load the spec once per (project, card). Title intentionally NOT a dependency.
  useEffect(() => {
    post({ type: 'requestSpec', path: projectPath, cardId: card.id });
    return subscribe((msg) => {
      if (msg.type === 'spec' && msg.path === projectPath && msg.cardId === card.id) {
        // Existing spec (even an empty one): load it verbatim — `exists` distinguishes
        // an absent file from an intentionally-empty one. Absent: seed a heading from the
        // card title so the first save creates a useful file.
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
    // Host persists + re-emits specsList; a save failure is surfaced as an error message
    // by the host (ADR §5). Close optimistically.
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
 * N3: Pipeline queue popover. Shows the queue depth summary — card titles, from→to
 * transitions, skill names, and relative times. Closes on Escape or outside click
 * (the backdrop is rendered by the parent). Positioned absolutely below the queue button
 * (`.board__queue-wrap` has `position: relative`).
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
