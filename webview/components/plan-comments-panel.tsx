import type { JSX as ReactJSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Rect } from '../../src/menu-position';
import type { PlanBlock } from '../../src/plan-blocks';
import { type AnchoredComment, MAX_COMMENT_TEXT } from '../../src/plan-comments';
import { commentMenu } from '../plan-menu';
import { relativeTime } from '../relative-time';
import { ContextMenu, type MenuState } from './context-menu';
import { NoteComposer } from './note-thread';
import { Popover } from './popover';

/** Spec §10: stamps are ISO-8601 UTC in the model and locale-formatted for the reader. */
const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function stampOf(iso: string): { label: string; title: string | undefined } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { label: '', title: undefined };
  return { label: relativeTime(ms), title: ABSOLUTE.format(ms) };
}

function blockLabel(block: PlanBlock | undefined, index: number): string {
  return `§${index + 1} ${block?.snippet ?? ''}`.trimEnd();
}

interface BlockPickerProps {
  blocks: readonly PlanBlock[];
  anchor: Rect;
  onPick: (index: number) => void;
  onClose: () => void;
}

function BlockPicker({ blocks, anchor, onPick, onClose }: BlockPickerProps) {
  const [active, setActive] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  useEffect(() => {
    frameRef.current?.focus();
  }, []);

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      ref={frameRef}
      className="plancomment__picker"
      tabIndex={-1}
      role="listbox"
      aria-label="Re-attach to…"
      aria-activedescendant={blocks.length > 0 ? `${baseId}-${active}` : undefined}
      onKeyDown={(e) => {
        const step = (dir: 1 | -1) => {
          e.preventDefault();
          setActive((i) => (i + dir + blocks.length) % blocks.length);
        };
        if (blocks.length === 0) return;
        if (e.key === 'ArrowDown') step(1);
        else if (e.key === 'ArrowUp') step(-1);
        else if (e.key === 'Home') {
          e.preventDefault();
          setActive(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          setActive(blocks.length - 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onPick(active);
        }
      }}
    >
      {blocks.map((b, i) => (
        <button
          key={b.hash}
          id={`${baseId}-${i}`}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`plancomment__picker-option${
            i === active ? ' plancomment__picker-option--active' : ''
          }`}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(i)}
        >
          {blockLabel(b, i)}
        </button>
      ))}
    </Popover>
  );
}

/**
 * `NoteComposer` plus the length counter spec §8 asks for. The textarea's own `maxLength` already
 * makes over-limit text untypable, so the counter is what tells the reader why the next keystroke
 * does nothing; `refused` is not the way to stop the save, because it makes the field read-only and
 * would strand the user at the cap with no way to trim.
 */
export function CommentComposer({
  label,
  initialBody,
  onSave,
  onCancel,
}: {
  label: string;
  initialBody?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [length, setLength] = useState(initialBody?.length ?? 0);
  const onBodyChange = useCallback((body: string) => {
    setLength(body.length);
  }, []);
  const atLimit = length >= MAX_COMMENT_TEXT;

  return (
    <div className="plancomment__composer">
      <NoteComposer
        label={label}
        initialBody={initialBody}
        onSave={onSave}
        onCancel={onCancel}
        onBodyChange={onBodyChange}
        saveDisabled={atLimit}
      />
      <span
        className={`plancomment__limit${atLimit ? ' plancomment__limit--reached' : ''}`}
        aria-live="polite"
      >
        {atLimit ? '4 KB limit' : `${length} / ${MAX_COMMENT_TEXT}`}
      </span>
    </div>
  );
}

type RowMode = 'idle' | 'reply' | 'edit' | 'confirm';

interface CommentRowProps {
  entry: AnchoredComment;
  blocks: readonly PlanBlock[];
  disabled: boolean;
  unsaved: boolean;
  onAdd: (index: number, text: string) => void;
  onEdit: (id: string, text: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onReattach: (id: string, index: number) => void;
  onJump: (index: number) => void;
  onRetry?: (id: string) => void;
}

function CommentRow({
  entry,
  blocks,
  disabled,
  unsaved,
  onAdd,
  onEdit,
  onResolve,
  onDelete,
  onReattach,
  onJump,
  onRetry,
}: CommentRowProps) {
  const { comment, index } = entry;
  const [mode, setMode] = useState<RowMode>('idle');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [picker, setPicker] = useState<Rect | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const resolved = comment.status === 'resolved';
  const detached = index === null;
  // A detached comment has no block, so a reply has nothing to hang on; the stored anchor index is
  // the closest thing to the author's intent and is clamped into range before it is offered.
  const replyIndex =
    index ??
    (blocks.length > 0 ? Math.min(Math.max(comment.anchor.index, 0), blocks.length - 1) : null);

  useEffect(() => {
    if (mode === 'confirm') confirmRef.current?.focus();
  }, [mode]);

  const backToRow = () => {
    setMode('idle');
    rowRef.current?.focus();
  };

  const openMenu = (x: number, y: number, keyboard?: boolean, anchor?: Rect) => {
    setMenu({
      x,
      y,
      keyboard,
      anchor,
      items: commentMenu({
        onReply: () => replyIndex !== null && setMode('reply'),
        onResolve: () => onResolve(comment.id, !resolved),
        onReattach: detached
          ? () => setPicker(rowRef.current?.getBoundingClientRect() ?? null)
          : null,
        onDelete: () => setMode('confirm'),
      }),
    });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLLIElement>) => {
    if (disabled || e.target !== e.currentTarget) return;
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r.left + 12, r.bottom - 8, true, r);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (replyIndex !== null) setMode('reply');
    } else if (e.key === 'Delete') {
      e.preventDefault();
      setMode('confirm');
    } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      onResolve(comment.id, !resolved);
    }
  };

  const className = [
    'plancomment__row',
    detached ? 'plancomment__row--detached' : '',
    resolved ? 'plancomment__row--resolved' : '',
    unsaved ? 'plancomment__row--unsaved' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const stamp = stampOf(comment.createdAt);

  return (
    <li
      ref={rowRef}
      role="listitem"
      className={className}
      data-comment-id={comment.id}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (disabled) return;
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="plancomment__anchor"
        disabled={disabled || detached}
        onClick={() => index !== null && onJump(index)}
      >
        {detached ? `(detached) ${comment.anchor.snippet}` : blockLabel(blocks[index], index)}
      </button>
      <div className="plancomment__meta">
        <span>{comment.author === 'agent' ? 'Agent' : 'You'}</span>
        <span title={stamp.title}>{stamp.label}</span>
        {resolved && <span>Resolved</span>}
        {comment.sentAt && <span>Sent</span>}
        {unsaved && <span>Couldn't save</span>}
      </div>
      <div className="plancomment__text">{comment.text}</div>

      {mode === 'edit' && (
        <CommentComposer
          label="Edit comment"
          initialBody={comment.text}
          onSave={(body) => {
            onEdit(comment.id, body);
            backToRow();
          }}
          onCancel={backToRow}
        />
      )}
      {mode === 'reply' && replyIndex !== null && (
        <CommentComposer
          label="Reply"
          onSave={(body) => {
            onAdd(replyIndex, body);
            backToRow();
          }}
          onCancel={backToRow}
        />
      )}
      {mode === 'confirm' && (
        <div className="plancomment__confirm">
          <span>Delete this comment?</span>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn--danger"
            onClick={() => onDelete(comment.id)}
          >
            Yes
          </button>
          <button type="button" className="btn" onClick={backToRow}>
            No
          </button>
        </div>
      )}

      <div className="plancomment__actions">
        <button
          type="button"
          disabled={disabled || replyIndex === null}
          onClick={() => setMode('reply')}
        >
          Reply
        </button>
        <button type="button" disabled={disabled} onClick={() => setMode('edit')}>
          Edit
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={resolved}
          onClick={() => onResolve(comment.id, !resolved)}
        >
          {resolved ? 'Unresolve' : 'Resolve'}
        </button>
        {detached && (
          <button
            type="button"
            disabled={disabled || blocks.length === 0}
            onClick={() => setPicker(rowRef.current?.getBoundingClientRect() ?? null)}
          >
            Re-attach to…
          </button>
        )}
        {unsaved && onRetry && (
          <button type="button" disabled={disabled} onClick={() => onRetry(comment.id)}>
            Retry
          </button>
        )}
        <button type="button" disabled={disabled} onClick={() => setMode('confirm')}>
          Delete
        </button>
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {picker && (
        <BlockPicker
          blocks={blocks}
          anchor={picker}
          onPick={(i) => {
            onReattach(comment.id, i);
            setPicker(null);
            rowRef.current?.focus();
          }}
          onClose={() => {
            setPicker(null);
            rowRef.current?.focus();
          }}
        />
      )}
    </li>
  );
}

export interface PlanCommentsPanelProps {
  anchored: readonly AnchoredComment[];
  blocks: readonly PlanBlock[];
  /** Before the first comments push for this plan: rows render, every action is inert (spec §4). */
  disabled: boolean;
  /** Comments whose write failed — driven by `plan:error op:'comments'`. */
  unsavedIds?: ReadonlySet<string>;
  onAdd(index: number, text: string): void;
  onEdit(id: string, text: string): void;
  onResolve(id: string, resolved: boolean): void;
  onDelete(id: string): void;
  onReattach(id: string, index: number): void;
  onJump(index: number): void;
  onRetry?(id: string): void;
}

export function PlanCommentsPanel({
  anchored,
  blocks,
  disabled,
  unsavedIds,
  onAdd,
  onEdit,
  onResolve,
  onDelete,
  onReattach,
  onJump,
  onRetry,
}: PlanCommentsPanelProps): ReactJSX.Element {
  const [adding, setAdding] = useState(false);
  const detachedHeadingId = useId();

  const { detached, open, resolved } = useMemo(() => {
    const byBlock = (a: AnchoredComment, b: AnchoredComment) =>
      (a.index ?? 0) - (b.index ?? 0) ||
      a.comment.createdAt.localeCompare(b.comment.createdAt) ||
      a.comment.id.localeCompare(b.comment.id);
    const attached = anchored.filter((e) => e.index !== null).sort(byBlock);
    return {
      detached: anchored.filter((e) => e.index === null),
      open: attached.filter((e) => e.comment.status === 'open'),
      resolved: attached.filter((e) => e.comment.status === 'resolved'),
    };
  }, [anchored]);

  const openCount = anchored.filter((e) => e.comment.status === 'open').length;

  const rowOf = (entry: AnchoredComment) => (
    <CommentRow
      key={entry.comment.id}
      entry={entry}
      blocks={blocks}
      disabled={disabled}
      unsaved={unsavedIds?.has(entry.comment.id) ?? false}
      onAdd={onAdd}
      onEdit={onEdit}
      onResolve={onResolve}
      onDelete={onDelete}
      onReattach={onReattach}
      onJump={onJump}
      onRetry={onRetry}
    />
  );

  return (
    <section className="plancomment" aria-label="Comments">
      {anchored.length === 0 ? (
        <p className="plancomment__empty">
          No comments yet. Press <kbd>c</kbd> on a block to comment.
        </p>
      ) : (
        <p className="plancomment__count">
          {openCount === 0
            ? `All ${anchored.length} resolved`
            : `${openCount} open comment${openCount === 1 ? '' : 's'}`}
        </p>
      )}

      {detached.length > 0 && (
        <div className="plancomment__group">
          <h3 id={detachedHeadingId}>Detached</h3>
          <ul role="list" aria-labelledby={detachedHeadingId}>
            {detached.map(rowOf)}
          </ul>
        </div>
      )}

      <ul role="list" aria-label="Comments">
        {open.map(rowOf)}
        {resolved.map(rowOf)}
      </ul>

      {adding ? (
        // Block 0 is the document's head: a comment typed in the panel has no block in focus, and
        // the gutter path (plan-view) is the one that does.
        <CommentComposer
          label="Comment"
          onSave={(body) => {
            onAdd(0, body);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="plancomment__actions">
          <button
            type="button"
            className="btn"
            disabled={disabled || blocks.length === 0}
            onClick={() => setAdding(true)}
          >
            Add comment
          </button>
        </div>
      )}
    </section>
  );
}
