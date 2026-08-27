import { useCallback, useRef, useState } from 'react';
import type { ReviewSource } from '../docs';
import { IconChevronDown } from '../icons';
import { conciseSourceLabel, reviewSourceLabel } from '../review-commit';
import { REVIEW_SCOPES, type ReviewScope, SCOPE_LABEL, scopeOfSource } from '../review-scope';
import { CommitPickerMenu } from './commit-picker-menu';
import { SegmentedRadios } from './segmented-radios';

const SCOPE_OPTIONS = REVIEW_SCOPES.map((id) => ({ id, label: SCOPE_LABEL[id] }));

/**
 * Review source control — the git-chrome trigger that opens the searchable {@link CommitPickerMenu}
 * (working tree ⇄ any recent commit / a pasted SHA). Lives in the tab row's trailing git group,
 * shown only while the Review tab is the active doc, NOT in the Review header
 * (spec 2026-06-29-review-changes-polish §A1; reverses review-commit-picker D2). The trigger shows
 * the CONCISE label; the verbose `reviewSourceLabel` is the title/aria.
 */
export function ReviewSourceControl({
  source,
  sessionId,
  onSetSource,
}: {
  source?: ReviewSource;
  sessionId?: string;
  onSetSource: (next: ReviewSource) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // A commit or a comparison has no index to scope against, so the control is absent there
  // rather than shown inert (spec 2026-08-27-review-supercharge §2 Lane D).
  const working = source === undefined || source.kind === 'working';
  const scope = scopeOfSource(source);

  const setScope = useCallback(
    (next: ReviewScope) =>
      onSetSource({ kind: 'working', ...(next === 'all' ? {} : { scope: next }) }),
    [onSetSource],
  );

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="gh__reffilter gitband__source"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Review source"
        title={reviewSourceLabel(source)}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gh__reffilter-label">{conciseSourceLabel(source)}</span>
        <IconChevronDown size={13} className="gh__reffilter-caret" />
      </button>
      {working && (
        <SegmentedRadios
          label="Scope"
          className="seg--sm gitband__scope"
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={setScope}
        />
      )}
      {open && (
        <CommitPickerMenu
          sessionId={sessionId}
          source={source}
          triggerRef={triggerRef}
          onSelect={onSetSource}
          onClose={close}
        />
      )}
    </>
  );
}
