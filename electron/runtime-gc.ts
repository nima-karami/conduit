import { join } from 'node:path';
import { versionOrder } from '../src/contracts/server-protocol';
import { SHIM_RUNTIME_DIR } from '../src/contracts/session-identity';

export interface RuntimeGcDeps {
  readdir(d: string): Promise<string[]>;
  rename(a: string, b: string): Promise<void>;
  rmrf(d: string): Promise<void>;
}

const SEMVER_DIR = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KEEP_NEWEST = 2;
/** A process's cwd (or another open handle) in the tree refuses the rename (M21). */
const IN_USE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const GC_SUFFIX = '.gc';

const newestFirst = (a: string, b: string) => {
  const order = versionOrder({ generation: 0, version: a }, { generation: 0, version: b });
  return order === 'same' ? 0 : order === 'appNewer' ? -1 : 1;
};

/** Version dirs past the newest two, never `current`; leftovers of an earlier GC or preparation. */
function candidates(entries: string[], current: string): string[] {
  const out: string[] = [];
  const versions = entries.filter((e) => SEMVER_DIR.test(e)).sort(newestFirst);
  for (const v of versions.slice(KEEP_NEWEST)) if (v !== current) out.push(v);
  for (const e of entries) if (e.endsWith(GC_SUFFIX) || e.endsWith('.tmp')) out.push(e);
  return out.filter((e) => !e.startsWith(SHIM_RUNTIME_DIR) || e.endsWith('.tmp'));
}

/**
 * D23: runs under the single-instance lock, before the start rule. Only a rename decides whether a
 * dir is still in use; nothing reads pids or holders.
 */
export async function collectRuntimeGarbage(
  runtimeRoot: string,
  keep: { appVersion: string; hcVersion: string },
  d: RuntimeGcDeps,
): Promise<{ removed: string[]; inUse: string[] }> {
  const removed: string[] = [];
  const inUse: string[] = [];
  const sweep = async (dir: string, current: string) => {
    for (const name of candidates(await listDir(d, dir), current)) {
      const path = join(dir, name);
      let doomed = path;
      if (!name.endsWith(GC_SUFFIX)) {
        doomed = `${path}${GC_SUFFIX}`;
        try {
          await d.rename(path, doomed);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && IN_USE_CODES.has(code)) {
            inUse.push(path);
            continue;
          }
          if (code === 'ENOENT') continue;
          throw error;
        }
      }
      await d.rmrf(doomed);
      removed.push(path);
    }
  };
  await sweep(runtimeRoot, keep.appVersion);
  await sweep(join(runtimeRoot, 'hc'), keep.hcVersion);
  await sweep(join(runtimeRoot, 'conduit-hc'), keep.hcVersion);
  return { removed, inUse };
}

async function listDir(d: RuntimeGcDeps, dir: string): Promise<string[]> {
  try {
    return await d.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
