import { useEffect, useRef } from 'react';
import { IconClose, IconSearch } from '../icons';

/**
 * Find bar for the rendered markdown viewer (spec 2026-07-01-markdown-search). A thin shell:
 * it renders the input + count + prev/next/close and reports intent to markdown-viewer.tsx,
 * which owns the find state and CSS-highlight painting. Reuses the `.term-find*` chrome for
 * visual parity (D4); adds a count element. Keys are handled on the input: Enter → next,
 * Shift+Enter → prev, Escape → close + refocus the rendered view.
 */
export function MdFindBar({
  query,
  ordinal,
  count,
  focusNonce,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  ordinal: number;
  count: number;
  /** Bumped by the viewer on each Ctrl/Cmd+F so a re-press refocuses + selects the input. */
  focusNonce: number;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // focusNonce is an intentional trigger (bumped on every Ctrl/Cmd+F), not read in the body,
  // so a re-press while the bar is already open refocuses + reselects the input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce is the re-focus trigger
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusNonce]);

  const hasQuery = query.trim().length > 0;
  const label = hasQuery ? `${ordinal}/${count}` : '';
  const disabled = count === 0;

  return (
    <div className="term-find term-find--md" role="search">
      <span className="term-find__icon">
        <IconSearch size={13} />
      </span>
      <input
        ref={inputRef}
        className="term-find__input"
        type="text"
        placeholder="Find in document"
        aria-label="Find in document"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span
        className={`term-find__count${hasQuery && disabled ? ' term-find__count--none' : ''}`}
        aria-live="polite"
      >
        {label}
      </span>
      <button
        type="button"
        className="term-find__btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={disabled}
        onClick={onPrev}
      >
        ↑
      </button>
      <button
        type="button"
        className="term-find__btn"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={disabled}
        onClick={onNext}
      >
        ↓
      </button>
      <button
        type="button"
        className="term-find__btn term-find__close"
        title="Close (Esc)"
        aria-label="Close find"
        onClick={onClose}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}
