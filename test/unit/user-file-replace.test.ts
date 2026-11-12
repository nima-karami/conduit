import { describe, expect, it } from 'vitest';
import { applyReplacedMode, checkReplaceable, type ModeIo } from '../../src/user-file-replace';

const errno = (code: string) => Object.assign(new Error(code), { code });

/** A scripted fs: `files` maps path -> stat; `writable` lists paths whose W_OK access succeeds. */
function fakeIo(
  files: Record<string, { mode: number; uid: number; gid: number }>,
  writable: string[],
) {
  const calls: string[] = [];
  const io: ModeIo = {
    async stat(p) {
      const s = files[p];
      if (!s) throw errno('ENOENT');
      return s;
    },
    async access(p) {
      calls.push(`access ${p}`);
      if (!writable.includes(p)) throw errno('EACCES');
    },
    async chmod(p, mode) {
      calls.push(`chmod ${p} ${mode.toString(8)}`);
    },
    async chown(p, uid, gid) {
      calls.push(`chown ${p} ${uid}:${gid}`);
    },
  };
  return { io, calls };
}

describe('checkReplaceable', () => {
  it('lets a save proceed over a missing target, with no mode to carry', async () => {
    const { io } = fakeIo({}, []);
    expect(await checkReplaceable('/w/new.ts', io)).toEqual({ ok: true, original: null });
  });

  it('captures the existing target mode and owner when it is writable', async () => {
    const { io } = fakeIo({ '/w/run.sh': { mode: 0o100755, uid: 1000, gid: 1000 } }, ['/w/run.sh']);
    expect(await checkReplaceable('/w/run.sh', io)).toEqual({
      ok: true,
      original: { mode: 0o100755, uid: 1000, gid: 1000 },
    });
  });

  it('refuses a target this process cannot write, naming it as read-only', async () => {
    const { io } = fakeIo({ '/w/ro.ts': { mode: 0o100444, uid: 1000, gid: 1000 } }, []);
    const result = await checkReplaceable('/w/ro.ts', io);
    expect(result).toEqual({
      ok: false,
      error: 'Permission denied: /w/ro.ts is read-only',
    });
  });
});

describe('applyReplacedMode', () => {
  it('gives the temp file the target mode bits, masked to 0o7777', async () => {
    const { io, calls } = fakeIo({ '/w/.tmp': { mode: 0o100644, uid: 1, gid: 1 } }, []);
    await applyReplacedMode('/w/.tmp', { mode: 0o100755, uid: 1, gid: 1 }, io);
    expect(calls).toEqual(['chmod /w/.tmp 755']);
  });

  it('does not chown when owner and group already match', async () => {
    const { io, calls } = fakeIo({ '/w/.tmp': { mode: 0o100644, uid: 7, gid: 8 } }, []);
    await applyReplacedMode('/w/.tmp', { mode: 0o100644, uid: 7, gid: 8 }, io);
    expect(calls.some((c) => c.startsWith('chown'))).toBe(false);
  });

  it('chowns to the target owner when they differ, then sets the mode', async () => {
    const { io, calls } = fakeIo({ '/w/.tmp': { mode: 0o100644, uid: 7, gid: 8 } }, []);
    await applyReplacedMode('/w/.tmp', { mode: 0o100600, uid: 9, gid: 8 }, io);
    expect(calls).toEqual(['chown /w/.tmp 9:8', 'chmod /w/.tmp 600']);
  });

  it.each(['EPERM', 'EINVAL'])('tolerates chown %s and still sets the mode', async (code) => {
    const calls: string[] = [];
    const io: ModeIo = {
      stat: async () => ({ mode: 0o100644, uid: 7, gid: 8 }),
      access: async () => {},
      chmod: async (_p, mode) => {
        calls.push(`chmod ${mode.toString(8)}`);
      },
      chown: async () => {
        throw errno(code);
      },
    };
    await applyReplacedMode('/w/.tmp', { mode: 0o100755, uid: 9, gid: 8 }, io);
    expect(calls).toEqual(['chmod 755']);
  });

  it('propagates a chown failure it does not expect', async () => {
    const io: ModeIo = {
      stat: async () => ({ mode: 0o100644, uid: 7, gid: 8 }),
      access: async () => {},
      chmod: async () => {},
      chown: async () => {
        throw errno('EROFS');
      },
    };
    await expect(
      applyReplacedMode('/w/.tmp', { mode: 0o100755, uid: 9, gid: 8 }, io),
    ).rejects.toThrow('EROFS');
  });
});
