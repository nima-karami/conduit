export interface Change {
  path: string;
  status: 'A' | 'M' | 'D';
}
export interface Affected {
  kind: 'none' | 'full' | 'names';
  names: string[];
  reasons: string[];
}
export function isE2eIrrelevant(path: string): boolean;
export function parseNameStatus(text: string): Change[];
export function importersFromMetafile(meta: {
  inputs?: Record<string, { imports?: { path: string }[] }>;
}): Record<string, string[]>;
export function selectAffected(
  changed: Change[],
  ctx: {
    map: { scenarios: Record<string, string[]> };
    importers: Record<string, string[]>;
    all: string[];
    core: string[];
    excluded?: string[];
  },
): Affected;
