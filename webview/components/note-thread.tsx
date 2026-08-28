import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { ReviewNote } from '../../src/protocol';
import { type AnchoredNote, MAX_NOTE_BODY } from '../../src/review-notes';
import { relativeTime } from '../relative-time';

/** ISO-8601 in the model, epoch ms in the shared formatter; a malformed stamp shows nothing. */
function stampedAgo(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : relativeTime(ms);
}

/** One note, rendered as a row inside the card's hunk rows (spec §2 Lane F, §8 "Note row"). */
export function NoteThread({
  note,
  disabled,
  onEdit,
  onResolve,
  onDelete,
}: {
  note: ReviewNote;
  /** True before the first `review:notes` push for this repo — the load gate (§4). */
  disabled: boolean;
  onEdit: (id: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (note: ReviewNote) => void;
}) {
  const [editing, setEditing] = useState(false);
  const resolved = note.resolvedAt !== undefined;

  if (editing) {
    return (
      <NoteComposer
        label={`Edit note on line ${note.line}`}
        initialBody={note.body}
        onSave={(body) => {
          onEdit(note.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`rnote${resolved ? ' rnote--resolved' : ''}`} data-note-id={note.id}>
      <div className="rnote__body">{note.body}</div>
      <div className="rnote__meta">
        <span>{stampedAgo(note.createdAt)}</span>
        {/* Text, not colour alone (§10). */}
        {resolved && <span>Resolved</span>}
        {note.sentAt && <span>Sent</span>}
        <button
          type="button"
          className="rnote__act rnote__edit"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          className="rnote__act rnote__resolve"
          disabled={disabled}
          aria-pressed={resolved}
          onClick={() => onResolve(note.id, !resolved)}
        >
          {resolved ? 'Unresolve' : 'Resolve'}
        </button>
        <button
          type="button"
          className="rnote__act rnote__delete"
          disabled={disabled}
          onClick={() => onDelete(note)}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * The inline composer row. `Mod+Enter` saves, `Esc` cancels — and the Esc keydown is stopped here
 * so it never reaches ReviewView's window-level Escape handler, which would close Review.
 */
export function NoteComposer({
  label,
  initialBody = '',
  refused,
  onSave,
  onCancel,
  onDirtyChange,
}: {
  label: string;
  initialBody?: string;
  /** Set when the repo is at its open-note cap; the field is read-only and the guidance shows. */
  refused?: string;
  onSave: (body: string) => void;
  onCancel: (dirty: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [body, setBody] = useState(initialBody);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const dirty = body.trim() !== initialBody.trim();

  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (body.trim()) onSave(body);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel(dirty);
    }
  };

  return (
    <div className="rnote-composer">
      <label className="sr-only" htmlFor={fieldId}>
        {label}
      </label>
      <textarea
        id={fieldId}
        ref={ref}
        className="rnote-composer__field"
        value={body}
        maxLength={MAX_NOTE_BODY}
        readOnly={!!refused}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="rnote-composer__row">
        <button
          type="button"
          className="btn btn--primary rnote-composer__save"
          disabled={!!refused || !body.trim()}
          onClick={() => onSave(body)}
        >
          Save
        </button>
        <button
          type="button"
          className="btn rnote-composer__cancel"
          onClick={() => onCancel(dirty)}
        >
          Cancel
        </button>
        {refused ? (
          <span className="rnote-composer__error" role="alert">
            {refused}
          </span>
        ) : (
          <span className="rnote-composer__hint">Ctrl/Cmd+Enter to save · Esc to cancel</span>
        )}
      </div>
    </div>
  );
}

/** Notes whose anchor no longer matches anything within the radius (§2 Lane F: never dropped). */
export function DetachedNotes({
  notes,
  disabled,
  onResolve,
  onDelete,
}: {
  notes: readonly AnchoredNote[];
  disabled: boolean;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (note: ReviewNote) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="rcard__detached" role="note">
      <p>
        {notes.length} note{notes.length === 1 ? '' : 's'} lost{' '}
        {notes.length === 1 ? 'its' : 'their'} place
      </p>
      {notes.map(({ note }) => (
        <div key={note.id} className="rnote rnote--detached" data-note-id={note.id}>
          <div className="rnote__body">
            was on line {note.line}: <code>{note.snippet}</code> — {note.body}
          </div>
          <div className="rnote__meta">
            <button
              type="button"
              className="rnote__act rnote__resolve"
              disabled={disabled}
              onClick={() => onResolve(note.id, note.resolvedAt === undefined)}
            >
              {note.resolvedAt === undefined ? 'Resolve' : 'Unresolve'}
            </button>
            <button
              type="button"
              className="rnote__act rnote__delete"
              disabled={disabled}
              onClick={() => onDelete(note)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
