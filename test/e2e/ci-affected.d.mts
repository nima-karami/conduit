export interface Hunk {
  start: number;
  count: number;
}
export interface Change {
  path: string;
  status: 'A' | 'M' | 'D';
  hunks?: Hunk[];
}
export interface Affected {
  kind: 'none' | 'full' | 'names';
  names: string[];
  reasons: string[];
}
export const MAP_SCHEMA: 2;
export function isE2eIrrelevant(path: string): boolean;
export function parseNameStatus(text: string): Change[];
export function parseZeroContextDiff(
  text: string,
): Record<string, { absent: boolean; hunks: Hunk[] }>;
export function selectAffected(
  changed: Change[],
  ctx: {
    // Loosely typed on purpose: the selector must reject an old-schema map it reads from state.
    map: { schema?: number; builtFrom: string; scenarios: Record<string, unknown> } | null;
    all: string[];
    core: string[];
    excluded?: string[];
  },
): Affected;
