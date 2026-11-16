import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { watchDir } from '../../electron/watch-dir';
import type { AuditEvent } from '../../server/network/audit-log';
import {
  createFsServe,
  FS_REFUSAL_AUDIT_MS,
  FS_WATCH_DEBOUNCE_MS,
  FS_WATCH_MAX,
  type FsServeDeps,
  type FsServeFrame,
  type FsStat,
} from '../../server/network/fs-serve';
import { sha256Of } from '../../server/network/sha256';
import { atomicWriteFileSync } from '../../src/atomic-write';
import type { LinkFrame, LinkState } from '../../src/contracts/link-protocol';
import { OWN_DEFAULT_CAPABILITIES } from '../../src/contracts/link-protocol';
import { MAX_BYTES, readDir, readFile } from '../../src/file-service';
import type { LinkRecord } from '../../src/network/link-file';
import type { DirEntryDTO } from '../../src/protocol';

// B serves files only to an inbound ssh controller, confined to a session's folders and deny-listed
// (CON-43 T1, spec 5.3). Real temp folders; the watcher is faked so events are deterministic.

const SESSION = 's1';
const CONTROLLER = 'm-controller';
const OTHER = 'm-other';

interface Sent {
  machineId: string;
  frame: LinkFrame;
}

let root: string;
let proj: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'fs-serve-'));
  proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'secret');
  fs.writeFileSync(path.join(proj, '.env'), 'TOKEN=1');
  fs.mkdirSync(path.join(proj, '.ssh'));
  fs.writeFileSync(path.join(proj, '.ssh', 'id'), 'key');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

const inbound = (machineId: string): LinkRecord => ({
  linkId: `l-${machineId}`,
  machineId,
  serverKey: 'k',
  ownerKey: null,
  name: machineId,
  trust: 'own',
  addresses: [],
  capabilities: { ...OWN_DEFAULT_CAPABILITIES },
  fingerprint: '',
  createdAt: '2026-11-16T00:00:00.000Z',
  cert: '',
  ownerTransfer: null,
  transport: 'ssh',
  ssh: null,
  machine: null,
});

const dialed = (machineId: string): LinkRecord => ({
  ...inbound(machineId),
  ssh: { target: 'b-host', node: 'node', mainJs: 'main.js', userData: '/ud' },
});

const tlsLink = (machineId: string): LinkRecord => ({
  ...inbound(machineId),
  transport: 'tls',
});

/** The real hash and atomic write, as index.ts wires them; the tests read the disk, not a stub. */
const hashOf = async (p: string): Promise<string | null> => {
  try {
    return sha256Of(await fs.promises.readFile(p));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

const statOf = async (p: string): Promise<FsStat> => {
  const st = await fs.promises.stat(p);
  return {
    kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
};

interface FakeWatch {
  dir: string;
  onEvent: (event: string, filename: string | null) => void;
  onGone: (error?: Error) => void;
  closes: number;
}

function harness(
  over: Partial<FsServeDeps> & {
    links?: Record<string, LinkRecord>;
    states?: Record<string, LinkState>;
  } = {},
) {
  const links: Record<string, LinkRecord> = over.links ?? { [CONTROLLER]: inbound(CONTROLLER) };
  const states: Record<string, LinkState> = over.states ?? {};
  const sent: Sent[] = [];
  const audits: AuditEvent[] = [];
  const fakes: FakeWatch[] = [];
  let at = 1_000_000;
  const fakeWatchDir: typeof watchDir = (dir, _opts, onEvent, onGone) => {
    const w: FakeWatch = { dir, onEvent, onGone, closes: 0 };
    fakes.push(w);
    return {
      close: () => {
        w.closes++;
      },
    };
  };
  const deps: FsServeDeps = {
    linkOf: (machineId) => links[machineId] ?? null,
    linkState: (machineId) => states[machineId] ?? 'up',
    sessionRoots: (sessionId) => (sessionId === SESSION ? [proj] : null),
    readDir: vi.fn(readDir),
    readFile: vi.fn(readFile),
    stat: vi.fn(statOf),
    hashFile: hashOf,
    writeFileAtomic: async (p, data) => atomicWriteFileSync(p, data),
    watchDir: fakeWatchDir,
    send: (machineId, frame) => {
      sent.push({ machineId, frame });
    },
    audit: { record: (e) => audits.push(e) },
    now: () => at,
    ...over,
  };
  return {
    serve: createFsServe(deps),
    deps,
    sent,
    audits,
    fakes,
    links,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

let seq = 0;
const req = (
  op: 'list' | 'read' | 'stat',
  p: string,
  sessionId = SESSION,
): Extract<FsServeFrame, { t: 'fs.req' }> => ({
  t: 'fs.req',
  id: `r${seq++}`,
  op,
  sessionId,
  path: p,
});

const resOf = (sent: Sent[], id: string) =>
  sent.find((s) => s.frame.t === 'fs.res' && s.frame.id === id)?.frame;

describe('fs-serve reads', () => {
  it('lists a folder inside a session and reads a file inside it', async () => {
    const h = harness();
    const list = req('list', proj);
    await h.serve.onFrame(CONTROLLER, list);
    const listed = resOf(h.sent, list.id);
    expect(listed).toMatchObject({ t: 'fs.res', ok: true, result: { op: 'list', path: proj } });

    const read = req('read', path.join(proj, 'a.txt'));
    await h.serve.onFrame(CONTROLLER, read);
    const got = resOf(h.sent, read.id);
    // A plain text read is editable on B, so it carries the hash of its bytes (the next save's
    // `expect`) and no `readOnlyReason`. The old `readOnlyReason: 'remote'` was B refusing to let
    // any tab save; B can save at this minor, so only the file's own reason remains.
    expect(got).toMatchObject({
      ok: true,
      result: {
        op: 'read',
        file: {
          path: path.join(proj, 'a.txt'),
          content: 'hello',
          hash: sha256Of(Buffer.from('hello')),
        },
      },
    });
    expect(
      got?.t === 'fs.res' && got.ok && got.result.op === 'read' ? got.result.file : null,
    ).not.toHaveProperty('readOnlyReason');
  });

  it("refuses a path outside the session's folders and reads nothing", async () => {
    const h = harness();
    const f = req('read', path.join(root, 'outside.txt'));
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(h.deps.readFile).not.toHaveBeenCalled();
    expect(h.deps.stat).not.toHaveBeenCalled();
    expect(h.deps.readDir).not.toHaveBeenCalled();
    if (process.platform === 'win32') return;
    // A link outside the folders that points inside them is still a path outside them.
    fs.symlinkSync(path.join(proj, 'a.txt'), path.join(root, 'inlink.txt'));
    const link = req('read', path.join(root, 'inlink.txt'));
    await h.serve.onFrame(CONTROLLER, link);
    expect(resOf(h.sent, link.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(h.deps.readFile).not.toHaveBeenCalled();
  });

  it('refuses .. segments', async () => {
    const h = harness();
    // Also one that resolves back inside the folder: the segment itself is what is refused.
    for (const p of [`${proj}/../outside.txt`, `${proj}/../proj/a.txt`]) {
      const f = req('read', p);
      await h.serve.onFrame(CONTROLLER, f);
      expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(h.deps.readFile).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink inside the folder that points outside',
    async () => {
      fs.symlinkSync(path.join(root, 'outside.txt'), path.join(proj, 'escape.txt'));
      const h = harness();
      const f = req('read', path.join(proj, 'escape.txt'));
      await h.serve.onFrame(CONTROLLER, f);
      expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
      expect(h.deps.readFile).not.toHaveBeenCalled();
    },
  );

  it('refuses a deny-listed read and reads nothing', async () => {
    const h = harness();
    for (const p of [path.join(proj, '.env'), path.join(proj, '.ssh', 'id')]) {
      const f = req('read', p);
      await h.serve.onFrame(CONTROLLER, f);
      expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(h.deps.readFile).not.toHaveBeenCalled();
  });

  it('omits denied entries from a listing', async () => {
    const h = harness();
    const f = req('list', proj);
    await h.serve.onFrame(CONTROLLER, f);
    const res = resOf(h.sent, f.id);
    expect(
      res?.t === 'fs.res' && res.ok && res.result.op === 'list' ? res.result.entries : null,
    ).toEqual<DirEntryDTO[]>([{ name: 'a.txt', kind: 'file' }]);
  });

  it('an image over 6 MiB is too_large', async () => {
    const h = harness();
    const big = path.join(proj, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024 + 1));
    const f = req('read', big);
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(h.deps.readFile).not.toHaveBeenCalled();
  });

  it('stats a file and reports its kind and size', async () => {
    const h = harness();
    const f = req('stat', path.join(proj, 'a.txt'));
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toMatchObject({
      ok: true,
      result: { op: 'stat', kind: 'file', size: 5 },
    });
  });

  it('unknown session is not_found', async () => {
    const h = harness();
    const f = req('read', path.join(proj, 'a.txt'), 'nope');
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(h.deps.readFile).not.toHaveBeenCalled();
  });

  it('a missing file inside a session is not_found', async () => {
    const h = harness();
    const f = req('read', path.join(proj, 'missing.txt'));
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('fs-serve controller rule', () => {
  it('refuses fs.req from a TLS link and from an A-side dialed ssh record, and audits once per minute', async () => {
    const h = harness({
      links: {
        [CONTROLLER]: inbound(CONTROLLER),
        [OTHER]: tlsLink(OTHER),
        'm-dial': dialed('m-dial'),
      },
    });
    const ids = [] as string[];
    for (const m of [OTHER, 'm-dial']) {
      for (let i = 0; i < 3; i++) {
        const f = req('read', path.join(proj, 'a.txt'));
        ids.push(f.id);
        await h.serve.onFrame(m, f);
        expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
      }
    }
    expect(h.deps.readFile).not.toHaveBeenCalled();
    expect(h.audits.filter((e) => e.kind === 'fs.refused')).toHaveLength(2);

    h.advance(FS_REFUSAL_AUDIT_MS);
    const again = req('read', path.join(proj, 'a.txt'));
    await h.serve.onFrame(OTHER, again);
    expect(h.audits.filter((e) => e.kind === 'fs.refused')).toHaveLength(3);
  });
});

describe('fs-serve watches', () => {
  it('the 65th watch is refused', async () => {
    const h = harness();
    for (let i = 0; i < FS_WATCH_MAX; i++)
      await h.serve.onFrame(CONTROLLER, {
        t: 'fs.watch',
        watchId: `w${i}`,
        sessionId: SESSION,
        path: proj,
      });
    expect(h.serve.watchCount(CONTROLLER)).toBe(FS_WATCH_MAX);
    await h.serve.onFrame(CONTROLLER, {
      t: 'fs.watch',
      watchId: 'w-extra',
      sessionId: SESSION,
      path: proj,
    });
    expect(h.serve.watchCount(CONTROLLER)).toBe(FS_WATCH_MAX);
    expect(h.audits.some((e) => e.kind === 'fs.refused')).toBe(true);
    expect(h.sent.some((s) => s.frame.t === 'fs.res')).toBe(false);
  });

  it("linkDown closes that link's watches", async () => {
    const h = harness({ links: { [CONTROLLER]: inbound(CONTROLLER), [OTHER]: inbound(OTHER) } });
    await h.serve.onFrame(CONTROLLER, {
      t: 'fs.watch',
      watchId: 'a',
      sessionId: SESSION,
      path: proj,
    });
    await h.serve.onFrame(CONTROLLER, {
      t: 'fs.watch',
      watchId: 'b',
      sessionId: SESSION,
      path: proj,
    });
    await h.serve.onFrame(OTHER, { t: 'fs.watch', watchId: 'c', sessionId: SESSION, path: proj });
    h.serve.linkDown(CONTROLLER);
    expect(h.serve.watchCount(CONTROLLER)).toBe(0);
    expect(h.serve.watchCount(OTHER)).toBe(1);
    expect(h.fakes.slice(0, 2).every((w) => w.closes === 1)).toBe(true);
    expect(h.fakes[2].closes).toBe(0);
  });

  it('a change under a watch sends one debounced fs.changed', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.serve.onFrame(CONTROLLER, {
      t: 'fs.watch',
      watchId: 'w',
      sessionId: SESSION,
      path: proj,
    });
    const w = h.fakes[0];
    expect(w.dir).toBe(fs.realpathSync.native(proj));
    w.onEvent('change', 'a.txt');
    vi.advanceTimersByTime(50);
    w.onEvent('change', 'a.txt');
    w.onEvent('rename', '.env');
    vi.advanceTimersByTime(50);
    w.onEvent('change', 'a.txt');
    expect(h.sent.filter((s) => s.frame.t === 'fs.changed')).toHaveLength(0);
    vi.advanceTimersByTime(150);
    const changed = h.sent.filter((s) => s.frame.t === 'fs.changed');
    expect(changed).toEqual([
      {
        machineId: CONTROLLER,
        frame: { t: 'fs.changed', watchId: 'w', paths: [path.join(proj, 'a.txt')] },
      },
    ]);
  });
});

describe('fs-serve symlinks and live links', () => {
  it('omits a symlink entry whose target is denied, from a listing and from a change', async () => {
    vi.useFakeTimers();
    fs.symlinkSync(path.join(proj, '.ssh'), path.join(proj, 'keys'));
    const h = harness();
    const f = req('list', proj);
    await h.serve.onFrame(CONTROLLER, f);
    const res = resOf(h.sent, f.id);
    expect(
      res?.t === 'fs.res' && res.ok && res.result.op === 'list' ? res.result.entries : null,
    ).toEqual<DirEntryDTO[]>([{ name: 'a.txt', kind: 'file' }]);

    await h.serve.onFrame(CONTROLLER, {
      t: 'fs.watch',
      watchId: 'w',
      sessionId: SESSION,
      path: proj,
    });
    const w = h.fakes[0];
    w.onEvent('change', 'keys');
    w.onEvent('change', 'a.txt');
    vi.advanceTimersByTime(FS_WATCH_DEBOUNCE_MS);
    expect(h.sent.filter((s) => s.frame.t === 'fs.changed').map((s) => s.frame)).toEqual([
      { t: 'fs.changed', watchId: 'w', paths: [path.join(proj, 'a.txt')] },
    ]);
  });

  it('a watch confirmed after linkDown is not registered, and a same-id watch after reconnect is accepted', async () => {
    const states: Record<string, LinkState> = {};
    let drop = (): void => {};
    const h = harness({
      states,
      stat: async (p) => {
        drop();
        return statOf(p);
      },
    });
    drop = () => {
      states[CONTROLLER] = 'down';
      h.serve.linkDown(CONTROLLER);
    };
    await h.serve.onFrame(CONTROLLER, {
      t: 'fs.watch',
      watchId: 'w1',
      sessionId: SESSION,
      path: proj,
    });
    expect(h.serve.watchCount(CONTROLLER)).toBe(0);
    expect(h.fakes).toHaveLength(0);

    states[CONTROLLER] = 'up';
    drop = () => {};
    await h.serve.onFrame(CONTROLLER, {
      t: 'fs.watch',
      watchId: 'w1',
      sessionId: SESSION,
      path: proj,
    });
    expect(h.serve.watchCount(CONTROLLER)).toBe(1);
    expect(h.audits.filter((e) => e.kind === 'fs.refused')).toHaveLength(0);
  });

  it('serves reads inside a session root that is itself a symlink', async () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(proj, alias);
    const h = harness({ sessionRoots: (sid) => (sid === SESSION ? [alias] : null) });
    const f = req('read', path.join(alias, 'a.txt'));
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toMatchObject({
      ok: true,
      result: { op: 'read', file: { content: 'hello' } },
    });
  });
});

describe('fs-serve reads: hash', () => {
  it('a truncated read and an invalid-utf8 read carry no hash', async () => {
    const h = harness();
    const big = path.join(proj, 'big.txt');
    fs.writeFileSync(big, 'a'.repeat(MAX_BYTES + 10));
    const trunc = req('read', big);
    await h.serve.onFrame(CONTROLLER, trunc);
    const t = resOf(h.sent, trunc.id);
    expect(t).toMatchObject({ ok: true, result: { op: 'read', file: { truncated: true } } });
    expect(
      t?.t === 'fs.res' && t.ok && t.result.op === 'read' ? t.result.file : null,
    ).not.toHaveProperty('hash');

    const bad = path.join(proj, 'bad.txt');
    fs.writeFileSync(bad, Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    const invalid = req('read', bad);
    await h.serve.onFrame(CONTROLLER, invalid);
    const i = resOf(h.sent, invalid.id);
    expect(i).toMatchObject({
      ok: true,
      result: { op: 'read', file: { readOnlyReason: 'invalid-utf8' } },
    });
    expect(
      i?.t === 'fs.res' && i.ok && i.result.op === 'read' ? i.result.file : null,
    ).not.toHaveProperty('hash');
  });
});

describe('fs-serve writes', () => {
  const wr = (
    p: string,
    data: string,
    expect: string | null,
    sessionId = SESSION,
  ): Extract<FsServeFrame, { t: 'fs.write' }> => ({
    t: 'fs.write',
    id: `w${seq++}`,
    sessionId,
    path: p,
    data,
    expect,
  });
  const H = (s: string) => sha256Of(Buffer.from(s, 'utf8'));
  const text = (p: string) => fs.readFileSync(p, 'utf8');

  it('a write whose expect matches lands, and replies with the hash of the data', async () => {
    const h = harness();
    const f = wr(path.join(proj, 'a.txt'), 'bye', H('hello'));
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toEqual({
      t: 'fs.res',
      id: f.id,
      ok: true,
      result: { op: 'write', hash: H('bye') },
    });
    expect(text(path.join(proj, 'a.txt'))).toBe('bye');
  });

  it('a wrong expect is a conflict with the file on disk hash, and the file is unchanged', async () => {
    const h = harness();
    const f = wr(path.join(proj, 'a.txt'), 'bye', H('stale'));
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toEqual({
      t: 'fs.res',
      id: f.id,
      ok: false,
      error: { code: 'conflict', message: expect.any(String), currentHash: H('hello') },
    });
    expect(text(path.join(proj, 'a.txt'))).toBe('hello');
  });

  it('expect null on an existing file is a conflict; on a missing file in a folder it creates it', async () => {
    const h = harness();
    const exists = wr(path.join(proj, 'a.txt'), 'x', null);
    await h.serve.onFrame(CONTROLLER, exists);
    expect(resOf(h.sent, exists.id)).toMatchObject({
      ok: false,
      error: { code: 'conflict', currentHash: H('hello') },
    });
    expect(text(path.join(proj, 'a.txt'))).toBe('hello');

    const created = wr(path.join(proj, 'new.txt'), 'fresh', null);
    await h.serve.onFrame(CONTROLLER, created);
    expect(resOf(h.sent, created.id)).toMatchObject({
      ok: true,
      result: { op: 'write', hash: H('fresh') },
    });
    expect(text(path.join(proj, 'new.txt'))).toBe('fresh');
  });

  it('an expect hash for a file that is gone is a conflict with null, and creates nothing', async () => {
    const h = harness();
    const gone = path.join(proj, 'missing.txt');
    const f = wr(gone, 'x', H('was here'));
    await h.serve.onFrame(CONTROLLER, f);
    expect(resOf(h.sent, f.id)).toMatchObject({
      ok: false,
      error: { code: 'conflict', currentHash: null },
    });
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('refuses .env, .ssh/x and the session .git/config, and writes nothing', async () => {
    const h = harness();
    const targets = [
      path.join(proj, '.env'),
      path.join(proj, '.ssh', 'id'),
      path.join(proj, '.git', 'config'),
    ];
    for (const p of targets) {
      const f = wr(p, 'pwned', null);
      await h.serve.onFrame(CONTROLLER, f);
      expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(text(path.join(proj, '.env'))).toBe('TOKEN=1');
    expect(text(path.join(proj, '.ssh', 'id'))).toBe('key');
    expect(fs.existsSync(path.join(proj, '.git'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a path outside the roots, and one whose parent is a link out of them',
    async () => {
      fs.symlinkSync(root, path.join(proj, 'escape'));
      const h = harness();
      const outside = wr(path.join(root, 'outside.txt'), 'pwned', H('secret'));
      await h.serve.onFrame(CONTROLLER, outside);
      expect(resOf(h.sent, outside.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
      expect(text(path.join(root, 'outside.txt'))).toBe('secret');

      const via = wr(path.join(proj, 'escape', 'new.txt'), 'pwned', null);
      await h.serve.onFrame(CONTROLLER, via);
      expect(resOf(h.sent, via.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
      expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a symlink inside the roots gets its target written, and stays a symlink',
    async () => {
      fs.writeFileSync(path.join(proj, 'target.txt'), 'tgt');
      fs.symlinkSync(path.join(proj, 'target.txt'), path.join(proj, 'link.txt'));
      const h = harness();
      const f = wr(path.join(proj, 'link.txt'), 'new', H('tgt'));
      await h.serve.onFrame(CONTROLLER, f);
      expect(resOf(h.sent, f.id)).toMatchObject({ ok: true, result: { op: 'write' } });
      expect(text(path.join(proj, 'target.txt'))).toBe('new');
      expect(fs.lstatSync(path.join(proj, 'link.txt')).isSymbolicLink()).toBe(true);
    },
  );

  it('a TLS link and a dialed ssh record cannot write', async () => {
    const h = harness({
      links: {
        [CONTROLLER]: inbound(CONTROLLER),
        [OTHER]: tlsLink(OTHER),
        'm-dial': dialed('m-dial'),
      },
    });
    for (const m of [OTHER, 'm-dial']) {
      const f = wr(path.join(proj, 'a.txt'), 'pwned', H('hello'));
      await h.serve.onFrame(m, f);
      expect(resOf(h.sent, f.id)).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(text(path.join(proj, 'a.txt'))).toBe('hello');
  });

  it('a missing parent folder is not_found, and a parent that is a file is not_found too', async () => {
    const h = harness();
    const noDir = wr(path.join(proj, 'nope', 'x.txt'), 'x', null);
    await h.serve.onFrame(CONTROLLER, noDir);
    expect(resOf(h.sent, noDir.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fs.existsSync(path.join(proj, 'nope'))).toBe(false);

    const underFile = wr(path.join(proj, 'a.txt', 'x.txt'), 'x', null);
    await h.serve.onFrame(CONTROLLER, underFile);
    expect(resOf(h.sent, underFile.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(text(path.join(proj, 'a.txt'))).toBe('hello');
  });
});
