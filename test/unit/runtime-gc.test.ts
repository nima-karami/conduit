import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRuntimeGarbage, type RuntimeGcDeps } from '../../electron/runtime-gc';

const ROOT = join('/u', 'runtime');
const HC = join(ROOT, 'hc');

/** A dir tree as a map of dir → entries; a path in `busy` refuses its rename like a held cwd. */
function fakeFs(tree: Record<string, string[]>, busy: string[] = []) {
  const dirs = new Map(Object.entries(tree).map(([k, v]) => [k, [...v]]));
  const log: string[] = [];
  const deps: RuntimeGcDeps = {
    readdir: async (d) => {
      const entries = dirs.get(d);
      if (!entries) throw Object.assign(new Error(`ENOENT ${d}`), { code: 'ENOENT' });
      return [...entries];
    },
    rename: async (a, b) => {
      if (busy.includes(a)) throw Object.assign(new Error(`EBUSY ${a}`), { code: 'EBUSY' });
      log.push(`rename ${a} -> ${b}`);
    },
    rmrf: async (d) => {
      log.push(`rm ${d}`);
    },
  };
  return { deps, log };
}

describe('collectRuntimeGarbage', () => {
  it('newest two kept, current always', async () => {
    const { deps, log } = fakeFs({
      [ROOT]: ['0.49.0', '0.52.0-beta.1', '0.51.0', '0.50.0', '0.52.0', 'hc', 'shim'],
      [HC]: ['0.1.14', '0.1.16', '0.1.15', '0.1.17'],
    });
    const r = await collectRuntimeGarbage(
      ROOT,
      { appVersion: '0.49.0', hcVersion: '0.1.14' },
      deps,
    );
    // Newest two by semver: 0.52.0 and its own pre-release; 0.49.0 is the running app.
    expect(r.removed.sort()).toEqual(
      [join(ROOT, '0.50.0'), join(ROOT, '0.51.0'), join(HC, '0.1.15')].sort(),
    );
    expect(r.inUse).toEqual([]);
    expect(log).toContain(`rename ${join(ROOT, '0.50.0')} -> ${join(ROOT, '0.50.0')}.gc`);
    expect(log).toContain(`rm ${join(ROOT, '0.50.0')}.gc`);
  });

  it('rename failure keeps dir', async () => {
    const held = join(ROOT, '0.48.0');
    const { deps, log } = fakeFs({ [ROOT]: ['0.48.0', '0.47.0', '0.51.0', '0.52.0'], [HC]: [] }, [
      held,
    ]);
    const r = await collectRuntimeGarbage(
      ROOT,
      { appVersion: '0.52.0', hcVersion: '0.1.16' },
      deps,
    );
    expect(r.inUse).toEqual([held]);
    expect(r.removed).toEqual([join(ROOT, '0.47.0')]);
    expect(log.some((l) => l.startsWith(`rm ${held}`))).toBe(false);
  });

  it('live shim dirs never touched', async () => {
    const { deps, log } = fakeFs({
      [ROOT]: ['shim', 'shim-2', 'shim.tmp', 'shim-2.gc', '0.52.0', '0.51.0.gc', '0.50.0.tmp'],
      [HC]: ['0.1.16'],
    });
    const r = await collectRuntimeGarbage(
      ROOT,
      { appVersion: '0.52.0', hcVersion: '0.1.16' },
      deps,
    );
    expect(log.filter((l) => l.includes('shim'))).toEqual([
      `rename ${join(ROOT, 'shim.tmp')} -> ${join(ROOT, 'shim.tmp')}.gc`,
      `rm ${join(ROOT, 'shim.tmp')}.gc`,
    ]);
    // Leftovers: a .gc goes straight to rm, a staging .tmp is renamed first.
    expect(r.removed.sort()).toEqual(
      [join(ROOT, '0.50.0.tmp'), join(ROOT, '0.51.0.gc'), join(ROOT, 'shim.tmp')].sort(),
    );
    expect(log).toContain(`rm ${join(ROOT, '0.51.0.gc')}`);
    expect(log).not.toContain(`rename ${join(ROOT, '0.51.0.gc')} -> ${join(ROOT, '0.51.0.gc')}.gc`);
  });

  it('removes leftover shim staging directories but preserves live shim generations', async () => {
    const { deps, log } = fakeFs({
      [ROOT]: ['shim', 'shim-2', 'shim.tmp', 'shim-2.tmp', 'shim-stage.tmp'],
      [HC]: [],
    });
    const r = await collectRuntimeGarbage(
      ROOT,
      { appVersion: '0.52.0', hcVersion: '0.1.16' },
      deps,
    );
    expect(r.removed.sort()).toEqual(
      [join(ROOT, 'shim.tmp'), join(ROOT, 'shim-2.tmp'), join(ROOT, 'shim-stage.tmp')].sort(),
    );
    expect(log.filter((line) => line.includes('shim'))).toHaveLength(6);
    expect(log).not.toContain(`rename ${join(ROOT, 'shim')} -> ${join(ROOT, 'shim')}.gc`);
    expect(log).not.toContain(`rename ${join(ROOT, 'shim-2')} -> ${join(ROOT, 'shim-2')}.gc`);
  });

  it('a missing runtime dir is nothing to collect', async () => {
    const { deps } = fakeFs({});
    expect(
      await collectRuntimeGarbage(ROOT, { appVersion: '0.52.0', hcVersion: '0.1.16' }, deps),
    ).toEqual({ removed: [], inUse: [] });
  });
});
