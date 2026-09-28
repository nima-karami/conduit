import { useEffect, useId, useState } from 'react';
import {
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  parseAutoSaveDelayInput,
} from '../../src/settings';
import { AUTO_SAVE_COPY } from '../auto-save-copy';

/** The auto-save delay input: commits only a valid value; an invalid draft never persists. */
export function AutoSaveDelayField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (ms: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = parseAutoSaveDelayInput(draft);
  const invalid = parsed === null;
  const commit = () => {
    if (parsed !== null && parsed !== value) onCommit(parsed);
  };
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {AUTO_SAVE_COPY.delayLabel}
      </label>
      <input
        id={id}
        type="number"
        className="set__number"
        min={AUTO_SAVE_DELAY_MIN}
        max={AUTO_SAVE_DELAY_MAX}
        step={100}
        value={draft}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={`${id}-msg`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setDraft(String(value));
        }}
        onBlur={() => {
          if (invalid) setDraft(String(value));
          else commit();
        }}
      />
      <span id={`${id}-msg`} className={invalid ? 'set__field-error' : 'set__desc'}>
        {invalid ? AUTO_SAVE_COPY.delayError : AUTO_SAVE_COPY.delayHint}
      </span>
    </>
  );
}
