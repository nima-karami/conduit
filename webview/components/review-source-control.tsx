import { useCallback, useRef, useState } from 'react';
import type { ReviewSource } from '../docs';
import { IconChevronDown } from '../icons';
import { conciseSourceLabel, reviewSourceLabel } from '../review-commit';
import { CommitPickerMenu } from './commit-picker-menu';

/**
 * Review source control — the git-band trigger that opens the searchable {@link CommitPickerMenu}
 * (working tree ⇄ any recent commit / a pasted SHA / a two-ref comparison). Lives on the git band
 * (center-gitband), shown only while the Review tab is the active doc, NOT in the Review header
 * (spec 2026-06-29-review-changes-polish §A1; reverses review-commit-picker D2). The trigger shows
 * the CONCISE label; the verbose `reviewSourceLabel` is the title/aria.
 */
export function ReviewSourceControl({
  source,
  sessionId,
  onSetSource,
  onOpenCompare,
}: {
  source?: ReviewSource;
  sessionId?: string;
  onSetSource: (next: ReviewSource) => void;
  /** Open the first-class Compare dialog from the picker's "Compare…" row (spec 2026-06-30). */
  onOpenCompare: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

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
      {open && (
        <CommitPickerMenu
          sessionId={sessionId}
          source={source}
          triggerRef={triggerRef}
          onSelect={onSetSource}
          onClose={close}
          onOpenCompare={() => {
            close();
            onOpenCompare();
          }}
        />
      )}
    </>
  );
}
