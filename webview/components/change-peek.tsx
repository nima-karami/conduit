import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { repoRelPath } from '../../src/repo-rel';
import { gitAction } from '../bridge';
import { type ChangeMarker, markerRange } from '../change-decorations';
import {
  applyHunkAction,
  BLOCKED_TOOLTIP,
  getHunkActionHost,
  hunkButtonMode,
  subscribeHunkActionHost,
  UNTRACKED_DISCARD_TOOLTIP,
} from '../hunk-actions';
import { pushToast } from '../toast-store';

/**
 * The change peek's contents (spec 2026-08-27-review-supercharge §2 Lane E, §8).
 *
 * Knows nothing about Monaco — usePeekZone owns the zone and portals this in — so the removed
 * lines can reuse Review's own row classes and the whole thing stays an ordinary component.
 */
export function ChangePeek({
  marker,
  index,
  total,
  path,
  untracked,
  onClose,
  onNext,
  onPrev,
  onAnnounce,
}: {
  marker: ChangeMarker;
  /** 0-based; the label and the aria-label are 1-based. */
  index: number;
  total: number;
  /** Absolute path of the open file. */
  path: string;
  untracked: boolean;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  onAnnounce: (text: string) => void;
}) {
  const host = useSyncExternalStore(subscribeHunkActionHost, getHunkActionHost, getHunkActionHost);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = `Change ${index + 1} of ${total}`;

  const rel = host?.root ? repoRelPath(host.root, path) : null;
  // The editor's baseline is HEAD→worktree, which is Review's All scope — so the same rule.
  const mode = hunkButtonMode('all', rel !== null && host?.stagedPaths.has(rel) === true);
  const canAct = rel !== null && mode === 'stage';

  useEffect(() => {
    // Opening moves focus into the dialog; usePeekZone's close() puts it back on the editor.
    // The container takes it, not the first button, so the first Tab still lands on Stage.
    rootRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // A focus TRAP, not a focus hint: Tab must not walk out into the editor's own widgets
      // while a dialog is open (§10).
      const focusable = [
        ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const run = useCallback(
    async (op: 'stageHunk' | 'discardHunk') => {
      if (rel === null) return;
      const outcome = await applyHunkAction(
        { host, gitAction, toast: pushToast, announce: onAnnounce },
        {
          op,
          absPath: path,
          relPath: rel,
          range: markerRange(marker),
          lineCount: marker.addedLines + marker.removedLines,
          untracked,
        },
      );
      // The markers recompute on their own: a discard rewrites the worktree, which the file
      // watcher already turns into a refetch. A stage changes neither the worktree nor HEAD,
      // so the markers are correctly unchanged — but the change is gone from the peek's point
      // of view either way, so it closes.
      if (outcome.kind === 'done') onClose();
      if (outcome.kind === 'unsupported') onAnnounce(UNTRACKED_DISCARD_TOOLTIP);
    },
    [host, marker, onAnnounce, onClose, path, rel, untracked],
  );

  return (
    <div
      ref={rootRef}
      className="peek"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="peek__head">
        <span className="peek__title">{label}</span>
        <button
          type="button"
          className="peek__act"
          disabled={!canAct}
          title={mode === 'blocked' ? BLOCKED_TOOLTIP : 'Stage this change'}
          onClick={() => void run('stageHunk')}
        >
          {untracked ? 'Stage file' : 'Stage'}
        </button>
        <button
          type="button"
          className="peek__act peek__act--danger"
          disabled={!canAct || untracked}
          title={
            untracked
              ? UNTRACKED_DISCARD_TOOLTIP
              : mode === 'blocked'
                ? BLOCKED_TOOLTIP
                : 'Discard this change'
          }
          onClick={() => void run('discardHunk')}
        >
          Discard
        </button>
        <button type="button" className="peek__nav" aria-label="Previous change" onClick={onPrev}>
          ↑
        </button>
        <button type="button" className="peek__nav" aria-label="Next change" onClick={onNext}>
          ↓
        </button>
        <button type="button" className="peek__nav" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="peek__lines">
        {untracked ? (
          <p className="peek__note">New file — no previous version.</p>
        ) : marker.removedText.length === 0 ? (
          <p className="peek__note">Nothing was removed here — these lines are new.</p>
        ) : (
          marker.removedText.map((text, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: removed lines are positional and stable for the life of this peek
            <pre key={i} className="rline rline--del">
              <span className="rline__gutter">{marker.oldRange[0] + i}</span>
              <span className="rline__gutter" />
              <span className="rline__sign">-</span>
              <span className="rline__text">{text === '' ? ' ' : text}</span>
            </pre>
          ))
        )}
      </div>
    </div>
  );
}
