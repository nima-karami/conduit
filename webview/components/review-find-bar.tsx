import { useEffect, useRef } from 'react';
import { IconClose, IconSearch } from '../icons';
import { matchCountLabel } from '../review-search';

/**
 * Review's find bar (spec 2026-08-27-review-supercharge §2 Lane C, §8). A thin shell over
 * intent: `review-view.tsx` owns the corpus, the cursor and the highlight painting. Reuses the
 * `.term-find*` chrome the terminal and markdown finders already share, as a static row rather
 * than a floating overlay — it sits above both the navigator and the card scroller.
 *
 * Escape is deliberately NOT handled here: Review runs one ordered Esc chain (search → help →
 * close) through `useEscapeKey`, and a second handler would race it.
 */
export function ReviewFindBar({
  query,
  caseSensitive,
  ordinal,
  count,
  capped,
  partial,
  loading,
  focusNonce,
  onQueryChange,
  onToggleCase,
  onNext,
  onPrev,
  onSearchAll,
  onClose,
}: {
  query: string;
  caseSensitive: boolean;
  /** 1-based position of the current match, 0 when there is none. */
  ordinal: number;
  count: number;
  /** The match list hit its ceiling, so `count` is a floor. */
  capped: boolean;
  /** "in N of M files" while part of a streaming source is still unloaded; null when complete. */
  partial: string | null;
  /** "Search all files" is fetching the rest. */
  loading: boolean;
  /** Bumped on every `/` or Mod+F so a re-press refocuses and reselects the input. */
  focusNonce: number;
  onQueryChange: (q: string) => void;
  onToggleCase: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSearchAll: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce is the re-focus trigger
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusNonce]);

  const hasQuery = query.length > 0;
  const none = hasQuery && count === 0;

  return (
    <div className="term-find term-find--review" role="search">
      <span className="term-find__icon">
        <IconSearch size={13} />
      </span>
      <input
        ref={inputRef}
        className="term-find__input"
        type="text"
        placeholder="Search changed lines"
        aria-label="Search changed lines"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (e.shiftKey) onPrev();
          else onNext();
        }}
      />
      {/* The whole status — count, coverage and the empty result — is one live region, so a
          screen reader hears one sentence per query rather than three racing updates (§9). */}
      <span
        className={`term-find__count review__searchstatus${none ? ' term-find__count--none' : ''}`}
        aria-live="polite"
      >
        {none ? 'No matches' : hasQuery ? matchCountLabel(ordinal, count, capped) : ''}
        {/* The coverage is shown for a zero-result query too: "No matches" over 3 of 198 files
            is a different claim from "No matches", and only one of them is true. */}
        {hasQuery && partial ? ` ${partial}` : ''}
        {loading ? ' — loading…' : ''}
      </span>
      {hasQuery && partial && !loading && (
        <button
          type="button"
          className="review__act review__searchall"
          title="Fetch the diffs that haven't loaded yet and search them too"
          onClick={onSearchAll}
        >
          Search all files
        </button>
      )}
      <button
        type="button"
        className="term-find__btn review__casebtn"
        aria-pressed={caseSensitive}
        title={caseSensitive ? 'Match case: on' : 'Match case: off'}
        aria-label="Match case"
        onClick={onToggleCase}
      >
        Aa
      </button>
      <button
        type="button"
        className="term-find__btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={count === 0}
        onClick={onPrev}
      >
        ↑
      </button>
      <button
        type="button"
        className="term-find__btn"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={count === 0}
        onClick={onNext}
      >
        ↓
      </button>
      <button
        type="button"
        className="term-find__btn term-find__close"
        title="Close (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}
