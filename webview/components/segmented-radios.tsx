import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRef } from 'react';

/**
 * A segmented control with real radiogroup semantics: roving tabindex, arrow keys that move
 * the selection (ARIA radio-group convention), Home/End. Shares the `.seg` skin with the
 * settings-modal segmented control, so it inherits the state vocabulary's quiet-role hover /
 * press / focus ladder (spec 2026-08-01-interaction-state-vocabulary).
 */
export function SegmentedRadios<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
  title,
}: {
  /** Accessible name of the group itself. */
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (next: T) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);

  const move = (delta: number) => {
    if (disabled) return;
    const i = options.findIndex((o) => o.id === value);
    const next = options[(i + delta + options.length) % options.length];
    if (!next || next.id === value) return;
    onChange(next.id);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-seg="${next.id}"]`)?.focus();
  };

  const select = (id: T) => {
    if (disabled) return;
    if (id !== value) onChange(id);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-seg="${id}"]`)?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') select(options[0].id);
    else if (e.key === 'End') select(options[options.length - 1].id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled ? 'true' : undefined}
      title={title}
      className={className ? `seg ${className}` : 'seg'}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          data-seg={o.id}
          aria-checked={o.id === value}
          // Spelled out rather than left to the text content: themes may apply
          // `text-transform: uppercase` (--label-case), which Chrome folds into the
          // computed accessible name.
          aria-label={o.label}
          tabIndex={o.id === value ? 0 : -1}
          disabled={disabled}
          className={o.id === value ? 'seg__btn seg__btn--active' : 'seg__btn'}
          onClick={() => {
            if (disabled) return;
            onChange(o.id);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
