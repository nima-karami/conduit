import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { watchDir } from '../../electron/watch-dir';
import type { AuditEvent } from '../../server/network/audit-log';
import {
  createFsServe,
  FS_REFUSAL_AUDIT_MS,
  FS_WATCH_MAX,
  type FsServeDeps,
  type FsServeFrame,
  type FsStat,
} from '../../server/network/fs-serve';
import type { LinkFrame } from '../../src/contracts/link-protocol';
import { OWN_DEFAULT_CAPABILITIES } from '../../src/contracts/link-protocol';
import { readDir, readFile } from '../../src/file-service';
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

function harness(over: Partial<FsServeDeps> & { links?: Record<string, LinkRecord> } = {}) {
  const links: Record<string, LinkRecord> = over.links ?? { [CONTROLLER]: inbound(CONTROLLER) };
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
    sessionRoots: (sessionId) => (sessionId === SESSION ? [proj] : null),
    readDir: vi.fn(readDir),
    readFile: vi.fn(readFile),
    stat: vi.fn(statOf),
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
    expect(got).toMatchObject({
      ok: true,
      result: {
        op: 'read',
        file: { path: path.join(proj, 'a.txt'), content: 'hello', readOnlyReason: 'remote' },
      },
    });
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
      links: { [CONTROLLER]: inbound(CONTROLLER), tls: tlsLink(OTHER), dial: dialed('m-dial') },
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
