import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRef, useState } from 'react';

/**
 * A segmented control with real radiogroup semantics: roving tabindex, arrow keys, Home/End.
 * By default arrows move the selection (ARIA radio-group convention). `selectOnArrow={false}`
 * is manual activation: arrows/Home/End move focus only and Space/Enter/click select — for groups
 * where every value walked through would be persisted (spec 2026-10-27-conduit-mcp-control-tools
 * §9). Shares the `.seg` skin with the settings-modal segmented control, so it inherits the state
 * vocabulary's quiet-role hover / press / focus ladder (spec 2026-08-01-interaction-state-vocabulary).
 */
export function SegmentedRadios<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
  title,
  selectOnArrow = true,
}: {
  /** Accessible name of the group itself. */
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (next: T) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  selectOnArrow?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  // Manual activation only: the option holding focus, which owns the tab stop while focus is
  // inside the group. Null once focus leaves, so Tab back in lands on the selected option.
  const [focused, setFocused] = useState<T | null>(null);
  const current = selectOnArrow ? value : (focused ?? value);
  const tabStop = options.some((o) => o.id === current) ? current : value;

  const focusOption = (id: T) => {
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-seg="${id}"]`)?.focus();
  };

  const go = (id: T) => {
    if (selectOnArrow) {
      if (id !== value) onChange(id);
    } else {
      setFocused(id);
    }
    focusOption(id);
  };

  const move = (delta: number) => {
    const i = options.findIndex((o) => o.id === tabStop);
    const next = options[(i + delta + options.length) % options.length];
    if (!next || next.id === tabStop) return;
    go(next.id);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') go(options[0].id);
    else if (e.key === 'End') go(options[options.length - 1].id);
    else if (!selectOnArrow && (e.key === ' ' || e.key === 'Enter')) {
      // Handled here rather than left to the button's native click so the activation is the
      // same keystroke everywhere; preventDefault suppresses that native click.
      if (tabStop !== value) onChange(tabStop);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!groupRef.current?.contains(e.relatedTarget as Node | null)) setFocused(null);
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
      onBlur={selectOnArrow ? undefined : onBlur}
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
          tabIndex={o.id === tabStop ? 0 : -1}
          disabled={disabled}
          className={o.id === value ? 'seg__btn seg__btn--active' : 'seg__btn'}
          onFocus={selectOnArrow ? undefined : () => setFocused(o.id)}
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
