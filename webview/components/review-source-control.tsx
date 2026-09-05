import { useCallback, useRef, useState } from 'react';
import type { ReviewSource } from '../docs';
import { IconChevronDown } from '../icons';
import { conciseSourceLabel, reviewSourceLabel } from '../review-commit';
import { REVIEW_SCOPES, type ReviewScope, SCOPE_LABEL, scopeOfSource } from '../review-scope';
import { CommitPickerMenu } from './commit-picker-menu';
import { SegmentedRadios } from './segmented-radios';

const SCOPE_OPTIONS = REVIEW_SCOPES.map((id) => ({ id, label: SCOPE_LABEL[id] }));

/** Review source control — trigger for the searchable CommitPickerMenu plus the All/Staged/Unstaged
 *  scope segment, in the Review header (spec 2026-09-05-review-mode §2.2). */
export function ReviewSourceControl({
  source,
  sessionId,
  onSetSource,
  onOpenCompare,
}: {
  source?: ReviewSource;
  sessionId?: string;
  onSetSource: (next: ReviewSource) => void;
  onOpenCompare: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const working = source === undefined || source.kind === 'working';
  const scope = scopeOfSource(source);

  const setScope = useCallback(
    (next: ReviewScope) =>
      onSetSource({ kind: 'working', ...(next === 'all' ? {} : { scope: next }) }),
    [onSetSource],
  );

  const close = useCallback(() => {
    setOpen(false);
    if (triggerRef.current?.isConnected) triggerRef.current.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="gh__reffilter review__source"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Review source"
        title={reviewSourceLabel(source)}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gh__reffilter-label">{conciseSourceLabel(source)}</span>
        <IconChevronDown size={13} className="gh__reffilter-caret" />
      </button>
      <SegmentedRadios
        label="Scope"
        className="seg--sm review__scope"
        value={scope}
        options={SCOPE_OPTIONS}
        onChange={setScope}
        disabled={!working}
        title={working ? undefined : 'A commit or comparison has no staged / unstaged split'}
      />
      {open && (
        <CommitPickerMenu
          sessionId={sessionId}
          source={source}
          triggerRef={triggerRef}
          onSelect={onSetSource}
          onClose={close}
          onOpenCompare={onOpenCompare}
        />
      )}
    </>
  );
}
