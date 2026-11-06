import type { OpenDoc } from './docs';

// see spec 2026-11-03-demand-driven-resources §3.2 G4 / D10
export function shownFilePaths(
  docs: readonly Pick<OpenDoc, 'kind' | 'path' | 'sessionId'>[],
  shownIds: readonly string[],
): string[] {
  const shown = new Set(shownIds);
  const paths = new Set<string>();
  for (const d of docs) if (d.kind === 'file' && shown.has(d.sessionId)) paths.add(d.path);
  return [...paths].sort();
}
