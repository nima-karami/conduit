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
import { emptyBoardData } from '../../src/conduit-store';
import { safeSpecFileName } from '../../src/spec-path';
import { post, subscribe } from '../bridge';
import { IconChevron, IconDoc, IconDuplicate, IconPencil, IconPlus, IconTrash } from '../icons';
import { relativeTime } from '../relative-time';
import { useEscapeKey } from '../use-escape-key';
import { ContextMenu, type MenuState } from './context-menu';

export function BoardView({ projectPath, onClose }: { projectPath?: string; onClose: () => void }) {
  // The board is per-project (`<projectPath>/.conduit/board.json`). With no project open
  // there is nowhere to persist, so it starts empty (never Conduit's own seed backlog).
  const [board, setBoard] = useState<BoardData>(() => emptyBoardData());
  const dragCard = useRef<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Card ids that have a spec on disk (`.conduit/specs/<id>.md`) — drives the indicator.
  const [specCardIds, setSpecCardIds] = useState<Set<string>>(() => new Set());
  // The card whose spec is open in the editor overlay (null = closed).
  const [specCard, setSpecCard] = useState<BoardCard | null>(null);
  // Cards register a "start renaming" callback here so the context menu's
  // Rename item can focus a card's existing inline title edit by id.
  const renamers = useRef(new Map<string, () => void>());

  useEffect(() => {
    if (projectPath) post({ type: 'requestBoard', path: projectPath });
    else {
      setBoard(emptyBoardData());
      setSpecCardIds(new Set());
    }
    return subscribe((msg) => {
      // Accept only board replies for the current project (ignore stale ones for a
      // previous project). A reply may be the initial load OR a live external edit the
      // host pushed because an agent advanced a card on disk.
      if (msg.type === 'board' && msg.path === projectPath) {
        // A live external update arrived: cancel any pending local save so we don't
        // immediately overwrite the agent's change with our stale in-flight edit —
        // external truth wins for the "agent advances cards" story.
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        setBoard(msg.board);
      }
      // The host's set of cards-with-a-spec (sent with the board + after each save).
      if (msg.type === 'specsList' && msg.path === projectPath) {
        setSpecCardIds(new Set(msg.cardIds));
      }
    });
  }, [projectPath]);

  // Close the board on Escape — but NOT while the spec editor overlay is open, or one
  // Escape would close both the modal and the board behind it. The SpecEditor owns Escape
  // while it's mounted.
  useEscapeKey(() => {
    if (!specCard) onClose();
  });

  // The host's specsList carries SANITIZED filename stems; derive the same stem from the
  // card id so a card whose id needed sanitizing (hostile/odd id) still matches its spec.
  const cardHasSpec = (card: BoardCard) => specCardIds.has(safeSpecFileName(card.id));

  const apply = (next: BoardData) => {
    setBoard(next);
    if (!projectPath) return; // no project => nowhere to persist
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => post({ type: 'updateBoard', path: projectPath, board: next }),
      300,
    );
  };

  // Right-click a card: app-styled menu wired to existing board ops.
  const onCardContextMenu = (e: React.MouseEvent, card: BoardCard) => {
    e.preventDefault();
    e.stopPropagation();
    const moveItems = STAGES.filter((s) => s.id !== card.stage).map((s, i) => ({
      label: `Move to ${s.label}`,
      icon: <IconChevron size={13} />,
      separatorBefore: i === 0,
      onClick: () => apply(moveCard(board, card.id, s.id)),
    }));
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
      </div>
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
                if (dragCard.current) apply(moveCard(board, dragCard.current, stage.id));
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

/** Compact, non-interactive footer showing relative created/updated times. */
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
