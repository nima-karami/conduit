import { describe, expect, it } from 'vitest';
import { type InstallFs, installTray, TRAY_EXE_NAME } from '../../server/tray/install';

const STABLE = '/u/runtime/tray';
const EXE = `${STABLE}/${TRAY_EXE_NAME}`;
const SOURCE = `/u/runtime/0.53.0/tray/${TRAY_EXE_NAME}`;

const errno = (code: string) => Object.assign(new Error(code), { code });

/** A Windows-like fs: a running image can be renamed but not unlinked or overwritten (S0-T5). */
function fakeFs(initial: Record<string, string>, o: { running?: Set<string> } = {}) {
  const files = new Map(Object.entries(initial));
  const running = o.running ?? new Set<string>();
  const ops: string[] = [];
  const failRename = new Set<string>();
  const failUnlink = new Set<string>();
  const fs: InstallFs = {
    async mkdir(dir) {
      ops.push(`mkdir ${dir}`);
    },
    async readdir(dir) {
      return [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1));
    },
    async exists(p) {
      return files.has(p);
    },
    async unlink(p) {
      ops.push(`unlink ${p}`);
      if (running.has(p) || failUnlink.has(p)) throw errno('EBUSY');
      if (!files.delete(p)) throw errno('ENOENT');
    },
    async rename(a, b) {
      ops.push(`rename ${a} -> ${b}`);
      if (failRename.has(a)) throw errno('EPERM');
      const v = files.get(a);
      if (v === undefined) throw errno('ENOENT');
      if (running.has(b)) throw errno('EPERM');
      files.delete(a);
      files.set(b, v);
      if (running.delete(a)) running.add(b);
    },
    async copyFile(a, b) {
      ops.push(`copy ${a} -> ${b}`);
      const v = files.get(a);
      if (v === undefined) throw errno('ENOENT');
      if (running.has(b)) throw errno('EBUSY');
      files.set(b, v);
    },
  };
  return { fs, files, running, ops, failRename, failUnlink };
}

const sha256 = (files: Map<string, string>) => async (p: string) => {
  const v = files.get(p);
  if (v === undefined) throw errno('ENOENT');
  return `sha:${v}`;
};

describe('installTray', () => {
  it('an equal hash is a no-op that runs the installed binary', async () => {
    const f = fakeFs({ [EXE]: 'v1', [SOURCE]: 'v1' });
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r).toEqual({ exe: EXE, swapped: false });
    expect(f.ops.filter((o) => !o.startsWith('mkdir'))).toEqual([]);
  });

  it('no installed binary: copy to .new, rename into place', async () => {
    const f = fakeFs({ [SOURCE]: 'v2' });
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r).toEqual({ exe: EXE, swapped: true });
    expect(f.files.get(EXE)).toBe('v2');
    expect(f.ops).toEqual([
      `mkdir ${STABLE}`,
      `copy ${SOURCE} -> ${EXE}.7.a.new`,
      `rename ${EXE}.7.a.new -> ${EXE}`,
    ]);
  });

  it('swaps by rename while the installed image is still running, and keeps the busy .old', async () => {
    const f = fakeFs({ [EXE]: 'v1', [SOURCE]: 'v2' }, { running: new Set([EXE]) });
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r.exe).toBe(EXE);
    expect(r.swapped).toBe(true);
    expect(f.files.get(EXE)).toBe('v2');
    expect(f.files.get(`${EXE}.7.a.old`)).toBe('v1');
    expect(f.ops).toContain(`rename ${EXE} -> ${EXE}.7.a.old`);
    expect(f.ops).toContain(`rename ${EXE}.7.a.new -> ${EXE}`);
    expect(f.ops.some((o) => o.startsWith(`unlink ${EXE}`) && !o.includes('.old'))).toBe(false);
  });

  it('a rename failure falls back to the installed binary and cleans up the .new', async () => {
    const f = fakeFs({ [EXE]: 'v1', [SOURCE]: 'v2' });
    f.failRename.add(EXE);
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r.exe).toBe(EXE);
    expect(r.swapped).toBe(false);
    expect(r.note).toMatch(/EPERM/);
    expect(f.files.get(EXE)).toBe('v1');
    expect(f.files.has(`${EXE}.7.a.new`)).toBe(false);
  });

  it('a failure on the final rename puts the old binary back', async () => {
    const f = fakeFs({ [EXE]: 'v1', [SOURCE]: 'v2' });
    f.failRename.add(`${EXE}.7.a.new`);
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r).toMatchObject({ exe: EXE, swapped: false });
    expect(f.files.get(EXE)).toBe('v1');
  });

  it('no installed binary and a failing copy runs the source directly', async () => {
    const f = fakeFs({ [SOURCE]: 'v2' });
    f.fs.copyFile = async () => {
      throw errno('ENOSPC');
    };
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r.exe).toBe(SOURCE);
    expect(r.swapped).toBe(false);
    expect(r.note).toMatch(/ENOSPC/);
  });

  it('a missing source with an installed binary runs the installed one', async () => {
    const f = fakeFs({ [EXE]: 'v1' });
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r.exe).toBe(EXE);
    expect(r.swapped).toBe(false);
    expect(r.note).toMatch(/source/i);
  });

  it('no source and nothing installed rejects: there is no binary', async () => {
    const f = fakeFs({});
    await expect(
      installTray({
        source: SOURCE,
        stableDir: STABLE,
        fs: f.fs,
        sha256: sha256(f.files),
        tag: '7.a',
      }),
    ).rejects.toThrow(/no tray binary/i);
  });

  it('sweeps stale .old/.new first; a busy one stays for next time', async () => {
    const f = fakeFs(
      {
        [EXE]: 'v1',
        [SOURCE]: 'v1',
        [`${EXE}.1.x.old`]: 'v0',
        [`${EXE}.2.y.new`]: 'v0',
        [`${EXE}.3.z.old`]: 'v0',
        [`${STABLE}/unrelated.txt`]: '',
      },
      { running: new Set([`${EXE}.3.z.old`]) },
    );
    const r = await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(r.exe).toBe(EXE);
    expect([...f.files.keys()].sort()).toEqual(
      [EXE, SOURCE, `${EXE}.3.z.old`, `${STABLE}/unrelated.txt`].sort(),
    );
    expect(r.note).toMatch(/3\.z\.old/);
  });

  it('removes its own .old right away when it is not in use', async () => {
    const f = fakeFs({ [EXE]: 'v1', [SOURCE]: 'v2' });
    await installTray({
      source: SOURCE,
      stableDir: STABLE,
      fs: f.fs,
      sha256: sha256(f.files),
      tag: '7.a',
    });
    expect(f.files.has(`${EXE}.7.a.old`)).toBe(false);
  });

  it('works with Windows separators', async () => {
    const stable = 'C:\\u\\runtime\\tray';
    const exe = `${stable}\\${TRAY_EXE_NAME}`;
    const files = new Map([
      [exe, 'v1'],
      ['C:\\src.exe', 'v2'],
    ]);
    const renames: string[] = [];
    const r = await installTray({
      source: 'C:\\src.exe',
      stableDir: stable,
      sep: '\\',
      fs: {
        mkdir: async () => {},
        readdir: async () => [TRAY_EXE_NAME],
        exists: async (p) => files.has(p),
        unlink: async (p) => {
          files.delete(p);
        },
        rename: async (a, b) => {
          renames.push(`${a}>${b}`);
          files.set(b, files.get(a) ?? '');
          files.delete(a);
        },
        copyFile: async (a, b) => {
          files.set(b, files.get(a) ?? '');
        },
      },
      sha256: sha256(files),
      tag: '7.a',
    });
    expect(r.exe).toBe(exe);
    expect(renames).toEqual([`${exe}>${exe}.7.a.old`, `${exe}.7.a.new>${exe}`]);
  });
});
