import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { handleFsCall } from '../../server/network/c2';
import { createFsClient, FS_REQ_MS } from '../../server/network/fs-client';
import type { LinkFrame, LinkState } from '../../src/contracts/link-protocol';
import { OWN_DEFAULT_CAPABILITIES } from '../../src/contracts/link-protocol';
import type { LinkRecord } from '../../src/network/link-file';

// A asks a machine it dialed over ssh for files (CON-43 T2, plan decisions 1, 7 and 8). Requests
// are never re-sent; a watch is desired state, re-sent each time its link comes up.

const machine = 'm-12345678';
const sshInbound = (over: Partial<LinkRecord> = {}): LinkRecord => ({
  linkId: 'l-1',
  machineId: machine,
  serverKey: 'key',
  ownerKey: null,
  name: 'laptop',
  trust: 'own',
  addresses: [],
  capabilities: { ...OWN_DEFAULT_CAPABILITIES, drive: false },
  fingerprint: '',
  createdAt: '2026-11-16T00:00:00.000Z',
  cert: '',
  ownerTransfer: null,
  transport: 'ssh',
  ssh: null,
  machine: null,
  ...over,
});
const dialed = (over: Partial<LinkRecord> = {}): LinkRecord =>
  sshInbound({ ssh: { target: 'h', node: 'n', mainJs: 'm', userData: 'u' }, ...over });

function setup(opts: {
  link?: LinkRecord | null;
  state?: LinkState | null;
  minor?: number | null;
  sendOk?: boolean | null;
}) {
  const sent: Array<{ machineId: string; frame: LinkFrame }> = [];
  const audit: AuditEvent[] = [];
  const emitted: Array<{ peer: object; type: string; data: unknown }> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let link: LinkRecord | null = opts.link === undefined ? dialed() : opts.link;
  let state: LinkState | null = opts.state === undefined ? 'up' : opts.state;
  const minor: number | null = opts.minor === undefined ? 4 : opts.minor;
  let n = 0;
  const fs = createFsClient({
    linkOf: () => link,
    linkState: () => state,
    peerMinor: () => minor,
    send: (machineId, frame) => {
      sent.push({ machineId, frame });
      return opts.sendOk === undefined ? true : opts.sendOk;
    },
    emitTo: (peer, type, data) => {
      emitted.push({ peer, type, data });
    },
    audit: { record: (e) => audit.push(e) },
    now: () => 1_000_000,
    newId: () => `r-${++n}`,
    after: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  return {
    fs,
    sent,
    audit,
    emitted,
    timers,
    setLink: (next: LinkRecord | null) => {
      link = next;
    },
    setState: (next: LinkState | null) => {
      state = next;
    },
    fire: () => {
      for (const t of timers)
        if (!t.cancelled) {
          t.cancelled = true;
          t.fn();
        }
    },
  };
}

const listing = {
  op: 'list' as const,
  path: '/a',
  entries: [{ name: 'x.txt', kind: 'file' as const }],
};

describe('fs request: A asks a dialed machine (CON-43 T2)', () => {
  it("a request resolves with B's result", async () => {
    const s = setup({});
    const pending = s.fs.request(machine, 'list', 'sess', '/a');
    expect(s.sent).toEqual([
      {
        machineId: machine,
        frame: { t: 'fs.req', id: 'r-1', op: 'list', sessionId: 'sess', path: '/a' },
      },
    ]);
    s.fs.onFrame(machine, { t: 'fs.res', id: 'r-1', ok: true, result: listing });
    expect(await pending).toEqual(listing);
  });

  it('times out as peer_unreachable and is never re-sent', async () => {
    const s = setup({});
    const pending = s.fs.request(machine, 'list', 'sess', '/a');
    expect(s.timers.map((t) => t.ms)).toEqual([FS_REQ_MS]);
    s.fire();
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
    expect(s.sent).toHaveLength(1);
  });

  it('a drop settles pending requests peer_unreachable', async () => {
    const s = setup({});
    const pending = s.fs.request(machine, 'list', 'sess', '/a');
    s.setState('down');
    s.fs.linksChanged([{ machineId: machine, state: 'down' }]);
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
    expect(s.sent).toHaveLength(1);
  });

  it('a forgotten machine settles pending requests', async () => {
    const s = setup({});
    s.fs.linksChanged([{ machineId: machine, state: 'up' }]);
    const pending = s.fs.request(machine, 'list', 'sess', '/a');
    s.fs.linksChanged([]);
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
  });

  it('a minor-3 peer is refused peer_incompatible without sending', async () => {
    const s = setup({ minor: 3 });
    await expect(s.fs.request(machine, 'list', 'sess', '/a')).rejects.toMatchObject({
      kind: 'peer_incompatible',
    });
    expect(s.sent).toEqual([]);
  });

  it('an ok:false answer maps its FsErrorCode to the same ServerErrorKind, failed to unavailable', async () => {
    const s = setup({});
    const refused = s.fs.request(machine, 'read', 'sess', '/a/.env');
    s.fs.onFrame(machine, {
      t: 'fs.res',
      id: 'r-1',
      ok: false,
      error: { code: 'refused', message: 'denied' },
    });
    await expect(refused).rejects.toMatchObject({ kind: 'refused', message: 'denied' });
    const failed = s.fs.request(machine, 'read', 'sess', '/a/b');
    s.fs.onFrame(machine, {
      t: 'fs.res',
      id: 'r-2',
      ok: false,
      error: { code: 'failed', message: 'read failed' },
    });
    await expect(failed).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('an answer of another op than the one asked is refused as unavailable', async () => {
    const s = setup({});
    const pending = s.fs.request(machine, 'stat', 'sess', '/a');
    s.fs.onFrame(machine, { t: 'fs.res', id: 'r-1', ok: true, result: listing });
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('an fs.res from a TLS record is dropped and audited', async () => {
    const s = setup({});
    const pending = s.fs.request(machine, 'list', 'sess', '/a');
    s.setLink(sshInbound({ transport: 'tls' }));
    s.fs.onFrame(machine, { t: 'fs.res', id: 'r-1', ok: true, result: listing });
    expect(s.audit).toEqual([
      { kind: 'fs.refused', peer: machine, detail: { reason: 'not_dialed', frame: 'fs.res' } },
    ]);
    s.fire();
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
  });

  it('a pending request across a live link change sends exactly one fs.req', async () => {
    const s = setup({});
    const pending = s.fs.request(machine, 'list', 'sess', '/a');
    s.fs.linksChanged([{ machineId: machine, state: 'degraded' }]);
    s.fs.linksChanged([{ machineId: machine, state: 'up' }]);
    expect(s.sent.filter((x) => x.frame.t === 'fs.req')).toHaveLength(1);
    s.fs.onFrame(machine, { t: 'fs.res', id: 'r-1', ok: true, result: listing });
    expect(await pending).toEqual(listing);
  });

  it('fs.res from a machine A did not dial is dropped and audited', async () => {
    const s = setup({});
    let settled = false;
    const pending = s.fs.request(machine, 'list', 'sess', '/a').then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    s.setLink(sshInbound());
    s.fs.onFrame(machine, { t: 'fs.res', id: 'r-1', ok: true, result: listing });
    s.fs.onFrame(machine, { t: 'fs.res', id: 'r-1', ok: true, result: listing });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(s.audit).toEqual([
      { kind: 'fs.refused', peer: machine, detail: { reason: 'not_dialed', frame: 'fs.res' } },
    ]);
    s.fire();
    await pending;
  });
});

describe('fs watches: desired state, re-sent on up (CON-43 T2)', () => {
  const peerA = { name: 'a' };
  const peerB = { name: 'b' };

  it('watches are re-sent when the link comes back up', () => {
    const s = setup({ state: 'down' });
    const watchId = s.fs.watch(peerA, machine, 'sess', '/a');
    expect(s.sent).toEqual([]);
    s.setState('up');
    s.fs.linksChanged([{ machineId: machine, state: 'up' }]);
    expect(s.sent).toEqual([
      { machineId: machine, frame: { t: 'fs.watch', watchId, sessionId: 'sess', path: '/a' } },
    ]);
  });

  it('a watch sent on a link that drops is re-sent once it comes back up', () => {
    const s = setup({});
    const watchId = s.fs.watch(peerA, machine, 'sess', '/a');
    expect(s.sent).toHaveLength(1);
    s.setState('down');
    s.fs.linksChanged([{ machineId: machine, state: 'down' }]);
    expect(s.sent).toHaveLength(1);
    s.setState('up');
    s.fs.linksChanged([{ machineId: machine, state: 'up' }]);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]).toEqual({
      machineId: machine,
      frame: { t: 'fs.watch', watchId, sessionId: 'sess', path: '/a' },
    });
  });

  it('a second up with no down sends no extra fs.watch', () => {
    const s = setup({});
    s.fs.watch(peerA, machine, 'sess', '/a');
    s.fs.linksChanged([{ machineId: machine, state: 'up' }]);
    s.fs.linksChanged([{ machineId: machine, state: 'up' }]);
    expect(s.sent.filter((x) => x.frame.t === 'fs.watch')).toHaveLength(1);
  });

  it('a replaced connection settles its requests and sends its watches again', async () => {
    const s = setup({});
    const watchId = s.fs.watch(peerA, machine, 'sess', '/a');
    const pending = s.fs.request(machine, 'list', 'sess', '/a');
    s.fs.reconnected(machine);
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
    const watchSends = s.sent.filter((x) => x.frame.t === 'fs.watch');
    expect(watchSends).toHaveLength(2);
    expect(watchSends[1]?.frame).toEqual({ t: 'fs.watch', watchId, sessionId: 'sess', path: '/a' });
  });

  it('watch refuses a peer known to predate file access as peer_incompatible', () => {
    const s = setup({ minor: 3 });
    expect(() => s.fs.watch(peerA, machine, 'sess', '/a')).toThrow(
      expect.objectContaining({ kind: 'peer_incompatible' }),
    );
    expect(s.sent).toEqual([]);
  });

  it('the 65th watch a peer holds on a machine is refused', () => {
    const s = setup({});
    for (let i = 0; i < 64; i++) s.fs.watch(peerA, machine, 'sess', `/a/${i}`);
    expect(() => s.fs.watch(peerA, machine, 'sess', '/a/65')).toThrow(
      expect.objectContaining({ kind: 'refused' }),
    );
    expect(() => s.fs.watch(peerB, machine, 'sess', '/a/65')).not.toThrow();
  });

  it('fs.changed goes only to the watching peer', () => {
    const s = setup({});
    const watchId = s.fs.watch(peerA, machine, 'sess', '/a');
    s.fs.watch(peerB, machine, 'sess', '/b');
    s.fs.onFrame(machine, { t: 'fs.changed', watchId, paths: ['/a/x.txt'] });
    expect(s.emitted).toEqual([
      { peer: peerA, type: 'remote.fs.changed', data: { watchId, paths: ['/a/x.txt'] } },
    ]);
  });

  it('peerGone unwatches its watches', () => {
    const s = setup({});
    const watchId = s.fs.watch(peerA, machine, 'sess', '/a');
    s.fs.peerGone(peerA);
    expect(s.sent.at(-1)).toEqual({ machineId: machine, frame: { t: 'fs.unwatch', watchId } });
    s.fs.onFrame(machine, { t: 'fs.changed', watchId, paths: [] });
    expect(s.emitted).toEqual([]);
  });

  it('unwatch refuses a watch the peer does not own', () => {
    const s = setup({});
    const watchId = s.fs.watch(peerA, machine, 'sess', '/a');
    expect(() => s.fs.unwatch(peerB, watchId)).toThrow(
      expect.objectContaining({ kind: 'not_found' }),
    );
  });
});

describe('remote.fs C2 methods refuse bad params as invalid (CON-43 T2)', () => {
  const peer = { name: 'app' };
  const fault = (f: () => unknown): unknown => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  };
  const d = () => {
    const s = setup({});
    return { fs: s.fs, peer };
  };
  const good = { machineId: machine, sessionId: 'sess', path: '/a' };

  it.each([
    ['remote.fs.list', { ...good, machineId: '' }],
    ['remote.fs.list', { ...good, sessionId: 'x'.repeat(65) }],
    ['remote.fs.list', { ...good, path: 'p'.repeat(4097) }],
    ['remote.fs.list', { sessionId: 'sess', path: '/a' }],
    ['remote.fs.read', { ...good, path: 7 }],
    ['remote.fs.read', { ...good, sessionId: undefined }],
    ['remote.fs.stat', { ...good, machineId: 3 }],
    ['remote.fs.stat', { ...good, path: '' }],
    ['remote.fs.watch', { ...good, path: 'p'.repeat(4097) }],
    ['remote.fs.watch', { ...good, sessionId: '' }],
    ['remote.fs.unwatch', { watchId: '' }],
    ['remote.fs.unwatch', {}],
  ])('%s refuses %j as invalid', (method, params) => {
    expect(fault(() => handleFsCall(method, params, d()))).toMatchObject({ kind: 'invalid' });
  });

  it('remote.fs.watch and remote.fs.unwatch need a connection', () => {
    const fs = setup({}).fs;
    expect(fault(() => handleFsCall('remote.fs.watch', good, { fs }))).toMatchObject({
      kind: 'invalid',
    });
    expect(fault(() => handleFsCall('remote.fs.unwatch', { watchId: 'w' }, { fs }))).toMatchObject({
      kind: 'invalid',
    });
  });

  it('remote.fs.list answers the listing as {path, entries}', async () => {
    const s = setup({});
    const out = handleFsCall('remote.fs.list', good, { fs: s.fs, peer });
    s.fs.onFrame(machine, { t: 'fs.res', id: 'r-1', ok: true, result: listing });
    expect(await out).toEqual({ path: '/a', entries: listing.entries });
  });
});
