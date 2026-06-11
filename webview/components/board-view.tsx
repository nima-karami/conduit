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
  seedBoard,
  updateCard,
} from '../../src/board';
import { post, subscribe } from '../bridge';
import { IconClose, IconDuplicate, IconPlus, IconTrash } from '../icons';
import { relativeTime } from '../relative-time';
import { useEscapeKey } from '../use-escape-key';

export function BoardView({ onClose }: { onClose: () => void }) {
  const [board, setBoard] = useState<BoardData>(() => seedBoard());
  const dragCard = useRef<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    post({ type: 'requestBoard' });
    return subscribe((msg) => {
      if (msg.type === 'board') setBoard(msg.board);
    });
  }, []);

  useEscapeKey(onClose);

  const apply = (next: BoardData) => {
    setBoard(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => post({ type: 'updateBoard', board: next }), 300);
  };

  return (
    <div className="board">
      <div className="board__head">
        <span className="board__title">Feature board</span>
        <span className="board__sub">
          Shared with the overnight agent · drag cards between columns
        </span>
        <button className="iconbtn" aria-label="Close board" onClick={onClose}>
          <IconClose size={15} />
        </button>
      </div>
      <div className="board__cols">
        {STAGES.map((stage) => {
          const cards = cardsIn(board, stage.id);
          return (
            <div
              key={stage.id}
              className={`bcol ${overStage === stage.id ? 'bcol--over' : ''}`}
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
                  />
                ))}
              </div>
              <AddCard onAdd={(title) => apply(addCard(board, stage.id, title))} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({
  card,
  onDragStart,
  onDragEnd,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  card: BoardCard;
  onDragStart: () => void;
  onDragEnd: () => void;
  onEdit: (patch: Partial<Omit<BoardCard, 'id'>>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState<null | 'title' | 'notes'>(null);
  const [draft, setDraft] = useState('');
  const begin = (field: 'title' | 'notes') => {
    setDraft(card[field] ?? '');
    setEditing(field);
  };
  const commit = () => {
    if (editing) onEdit({ [editing]: draft } as Partial<BoardCard>);
    setEditing(null);
  };

  return (
    <div
      className="bcard"
      draggable={!editing}
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
