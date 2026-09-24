import type { probeFolder } from './folder-validation';
import { mapWithConcurrency } from './git-exec';
import { type FolderProbeResult, MAX_PROBE_PATHS } from './protocol';
import type { GitInfo } from './types';

const GIT_CONCURRENCY = 4;

/** Read-only: mf-model's one folder validator, then the existing git interrogation for a branch. */
export async function probeFolders(
  paths: unknown,
  deps: {
    probe: (raw: unknown) => ReturnType<typeof probeFolder>;
    gitInfo: (dir: string) => Promise<GitInfo>;
  },
): Promise<FolderProbeResult[]> {
  if (!Array.isArray(paths)) return [];
  const wanted = paths.slice(0, MAX_PROBE_PATHS).filter((p): p is string => typeof p === 'string');
  return mapWithConcurrency(wanted, GIT_CONCURRENCY, async (path) => {
    const probed = await deps.probe(path);
    if ('reason' in probed || probed.status !== 'present') return { path, exists: false };
    const info = await deps.gitInfo(probed.stored).catch(() => undefined);
    if (info?.kind === 'branch' && info.branch) return { path, exists: true, branch: info.branch };
    if (info?.kind === 'detached' && info.sha) {
      return { path, exists: true, branch: info.sha, detached: true };
    }
    return { path, exists: true };
  });
}
