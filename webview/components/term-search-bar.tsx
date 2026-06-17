import { useEffect, useRef } from 'react';
import { IconClose, IconSearch } from '../icons';

/**
 * Terminal find bar overlay (L4). A thin shell: renders the input + prev/next/close and
 * reports intent to terminal-pane.tsx, which owns the reducer and drives xterm's
 * SearchAddon. Keys are handled on the input (not the window/xterm): Enter → next,
 * Shift+Enter → previous, Escape → close + refocus the terminal.
 */
export function TermSearchBar({
  query,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select the input on open so the user can type / overtype immediately.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <div className="term-find" role="search">
      <span className="term-find__icon">
        <IconSearch size={13} />
      </span>
      <input
        ref={inputRef}
        className="term-find__input"
        type="text"
        placeholder="Find"
        aria-label="Find in terminal"
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
      <button
        type="button"
        className="term-find__btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        onClick={onPrev}
      >
        ↑
      </button>
      <button
        type="button"
        className="term-find__btn"
        title="Next match (Enter)"
        aria-label="Next match"
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
