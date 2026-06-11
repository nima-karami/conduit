// Workbench layout: an ordered permutation of the three regions. `center`
// (Terminal/Docs) is always the flexible column; the two side panels carry widths.

export type Region = 'sessions' | 'center' | 'explorer';
const REGIONS: Region[] = ['sessions', 'center', 'explorer'];
export const DEFAULT_LAYOUT = 'sessions,center,explorer';

/** Parse a comma-joined order; falls back to the default if it isn't a valid permutation. */
export function parseLayout(s: string): Region[] {
  const parts = s.split(',').map((p) => p.trim());
  const set = new Set(parts);
  if (parts.length === 3 && REGIONS.every((r) => set.has(r))) return parts as Region[];
  return [...REGIONS];
}

export function serializeLayout(order: Region[]): string {
  return order.join(',');
}

/** Which edge of a side panel faces the center column (where its resize handle goes). */
export function centerFacingEdge(order: Region[], region: Region): 'left' | 'right' {
  return order.indexOf(region) < order.indexOf('center') ? 'right' : 'left';
}
