import type { JSX as ReactJSX } from 'react';
import { useId } from 'react';
import { handoffLabel } from '../../src/review-handoff';

export interface PlanActionBarProps {
  pending: number;
  live: boolean;
  sendBlockedReason: string | null;
  saveState: 'saved' | 'saving' | 'failed' | 'readonly';
  source: boolean;
  nextCount: number;
  onSend: () => void;
  onToggleSource: () => void;
  onNextChange: () => void;
  onRetrySave: () => void;
}

const SAVE_TEXT: Record<PlanActionBarProps['saveState'], string> = {
  saved: 'Saved',
  saving: 'Saving…',
  failed: "Couldn't save",
  readonly: 'This file is read-only',
};

/** The plan document's bottom bar: save state, Next change, Source, Send/Copy (spec §8, §9). */
export function PlanActionBar({
  pending,
  live,
  sendBlockedReason,
  saveState,
  source,
  nextCount,
  onSend,
  onToggleSource,
  onNextChange,
  onRetrySave,
}: PlanActionBarProps): ReactJSX.Element {
  const blockedId = useId();
  const handoff = handoffLabel(pending, live);
  const sendLabel = pending === 0 && live ? 'Nothing to send' : handoff.label;
  const sendDisabled = handoff.disabled || sendBlockedReason !== null || saveState === 'failed';
  const sendTitle = sendBlockedReason ? `${handoff.title} — ${sendBlockedReason}` : handoff.title;

  return (
    <div className="plan__actionbar" role="toolbar" aria-label="Plan actions">
      <span className="plan__save">{SAVE_TEXT[saveState]}</span>
      {saveState === 'failed' && (
        <button type="button" className="btn plan__retry" onClick={onRetrySave}>
          Retry
        </button>
      )}
      {nextCount > 0 && (
        <button type="button" className="btn plan__next" onClick={onNextChange}>
          Next change ({nextCount})
        </button>
      )}
      <div className="plan__actionbar-right">
        <button
          type="button"
          className="btn plan__source"
          aria-pressed={source}
          onClick={onToggleSource}
        >
          Source
        </button>
        <button
          type="button"
          className="btn btn--primary plan__send"
          disabled={sendDisabled}
          aria-disabled={sendDisabled}
          aria-describedby={sendBlockedReason ? blockedId : undefined}
          title={sendTitle}
          onClick={onSend}
        >
          {sendLabel}
        </button>
        {sendBlockedReason && (
          <span id={blockedId} className="sr-only">
            {sendBlockedReason}
          </span>
        )}
      </div>
    </div>
  );
}
