/**
 * Painting Review's search hits with the CSS Custom Highlight API (spec
 * 2026-08-27-review-supercharge §2 Lane C), the same way the markdown finder does: Ranges over
 * the existing text nodes, so no wrapper element is injected into a diff row. That matters more
 * here than there — `Line` is memoised on its `line` object, and mutating a row's DOM under it
 * would be undone by the next reconcile, and would break the word-diff spans it already renders.
 */

/** One key pair for the whole app: Review is a singleton tab, so no instance suffix is needed. */
const HL_ALL = 'review-find';
const HL_CURRENT = 'review-find-current';

let painted = false;

export const highlightApiAvailable = (): boolean =>
  typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

/**
 * Map a [start, end) offset range within a row's text onto a DOM Range. `.rline__text` renders
 * the line as a run of `<span>`s (syntax tokens, further split by word-diff emphasis), so a
 * match routinely starts in one and ends in another.
 */
export function rangeInRowText(textEl: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let anchored = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.nodeValue?.length ?? 0;
    if (!anchored && start < offset + len) {
      range.setStart(node, start - offset);
      anchored = true;
    }
    if (anchored && end <= offset + len) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += len;
  }
  return null;
}

export function paintReviewHighlights(all: readonly Range[], current: Range | null): void {
  if (!highlightApiAvailable()) return;
  if (all.length === 0) CSS.highlights.delete(HL_ALL);
  else CSS.highlights.set(HL_ALL, new Highlight(...all));
  if (current === null) CSS.highlights.delete(HL_CURRENT);
  else CSS.highlights.set(HL_CURRENT, new Highlight(current));
  painted = all.length > 0 || current !== null;
}

/** Clears only what this module painted, so an idle Review can't wipe another surface's find. */
export function clearReviewHighlights(): void {
  if (!painted || !highlightApiAvailable()) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CURRENT);
  painted = false;
}
