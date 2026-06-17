/**
 * Pure selection logic for directional tab-close commands (R7). Returns the
 * subset of paths to close for each mode; the caller runs each through the
 * dirty-close confirm flow.
 */

export type TabCloseMode = 'close' | 'right' | 'left' | 'others' | 'all';

/**
 * Returns the ordered list of paths to close for the given mode. A missing
 * `anchor` yields an empty array for every mode except `all` (returns everything).
 */
export function closeTabSelection(
  paths: readonly string[],
  anchor: string,
  mode: TabCloseMode,
): string[] {
  if (mode === 'all') return [...paths];

  const idx = paths.indexOf(anchor);
  if (idx === -1) {
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
