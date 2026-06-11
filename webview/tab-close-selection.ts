/**
 * Pure selection logic for directional tab-close commands (R7).
 *
 * Given an ordered list of open doc paths and an anchor path, returns the
 * subset to close for each mode. The caller is responsible for running each
 * returned path through the dirty-close confirm flow.
 *
 * Pure and DOM-free so it has a single, unit-tested source of truth with no
 * React/host dependency.
 */

export type TabCloseMode = 'close' | 'right' | 'left' | 'others' | 'all';

/**
 * Returns the ordered list of paths to close for the given mode.
 *
 * - `close`  — just the anchor
 * - `right`  — every path after the anchor (anchor excluded)
 * - `left`   — every path before the anchor (anchor excluded)
 * - `others` — every path except the anchor
 * - `all`    — every path including the anchor
 *
 * If `anchor` is not found in `paths`, returns an empty array for all modes
 * except `all` (which returns everything).
 */
export function closeTabSelection(
  paths: readonly string[],
  anchor: string,
  mode: TabCloseMode,
): string[] {
  if (mode === 'all') return [...paths];

  const idx = paths.indexOf(anchor);
  if (idx === -1) {
    // Anchor not found — nothing to close directionally or as 'others'.
    return [];
  }

  switch (mode) {
    case 'close':
      return [anchor];
    case 'right':
      return paths.slice(idx + 1) as string[];
    case 'left':
      return paths.slice(0, idx) as string[];
    case 'others':
      return paths.filter((p) => p !== anchor) as string[];
  }
}
