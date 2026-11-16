import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { handleGitCall } from '../../server/network/c2';
import { createGitClient, GIT_REQ_MS } from '../../server/network/git-client';
import type { LinkFrame, LinkState } from '../../src/contracts/link-protocol';
import { GIT_MIN_MINOR, OWN_DEFAULT_CAPABILITIES } from '../../src/contracts/link-protocol';
import type { LinkRecord } from '../../src/network/link-file';

// A asks a machine it dialed over ssh for git reads (CON-45 G2, plan decision 1). Requests are
// never re-sent; a drop or a timeout is the caller's to report.

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
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let link: LinkRecord | null = opts.link === undefined ? dialed() : opts.link;
  let state: LinkState | null = opts.state === undefined ? 'up' : opts.state;
  const minor: number | null = opts.minor === undefined ? GIT_MIN_MINOR : opts.minor;
  let n = 0;
  const git = createGitClient({
    linkOf: () => link,
    linkState: () => state,
    peerMinor: () => minor,
    send: (machineId, frame) => {
      sent.push({ machineId, frame });
      return opts.sendOk === undefined ? true : opts.sendOk;
    },
    audit: { record: (e) => audit.push(e) },
    now: () => 1_000_000,
    newId: () => `g-${++n}`,
    after: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  return {
    git,
    sent,
    audit,
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

const showResult = { op: 'show' as const, files: [], truncated: false };

describe('git request: A asks a dialed machine (CON-45 G2)', () => {
  it("a request resolves with B's result", async () => {
    const s = setup({});
    const pending = s.git.request(machine, 'show', 'sess', '/repo', { sha: 'abc1234' });
    expect(s.sent).toEqual([
      {
        machineId: machine,
        frame: {
          t: 'git.req',
          id: 'g-1',
          op: 'show',
          sessionId: 'sess',
          root: '/repo',
          args: { sha: 'abc1234' },
        },
      },
    ]);
    s.git.onFrame(machine, { t: 'git.res', id: 'g-1', ok: true, result: showResult });
    expect(await pending).toEqual(showResult);
  });

  it('times out as peer_unreachable and is never re-sent', async () => {
    const s = setup({});
    const pending = s.git.request(machine, 'status', 'sess', '/repo', {});
    expect(s.timers.map((t) => t.ms)).toEqual([GIT_REQ_MS]);
    s.fire();
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
    expect(s.sent).toHaveLength(1);
  });

  it('a drop settles pending requests', async () => {
    const s = setup({});
    s.git.linksChanged([{ machineId: machine, state: 'up' }]);
    const pending = s.git.request(machine, 'status', 'sess', '/repo', {});
    s.git.linksChanged([{ machineId: machine, state: 'down' }]);
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
    expect(s.sent).toHaveLength(1);
  });

  it('a replaced connection settles pending requests', async () => {
    const s = setup({});
    const pending = s.git.request(machine, 'status', 'sess', '/repo', {});
    s.git.reconnected(machine);
    await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
    expect(s.sent).toHaveLength(1);
  });

  it('a peer below GIT_MIN_MINOR is refused peer_incompatible without sending', async () => {
    const s = setup({ minor: GIT_MIN_MINOR - 1 });
    await expect(s.git.request(machine, 'status', 'sess', '/repo', {})).rejects.toMatchObject({
      kind: 'peer_incompatible',
    });
    expect(s.sent).toEqual([]);
  });

  it('a git.res from a TLS record or an inbound record is dropped and audited', async () => {
    for (const link of [sshInbound({ transport: 'tls' }), sshInbound()]) {
      const s = setup({});
      const pending = s.git.request(machine, 'status', 'sess', '/repo', {});
      s.setLink(link);
      s.git.onFrame(machine, { t: 'git.res', id: 'g-1', ok: true, result: showResult });
      expect(s.audit).toEqual([
        {
          kind: 'fs.refused',
          peer: machine,
          detail: { reason: 'not_dialed', frame: 'git.res' },
        },
      ]);
      s.fire();
      await expect(pending).rejects.toMatchObject({ kind: 'peer_unreachable' });
    }
  });

  it('a mismatched op is unavailable', async () => {
    const s = setup({});
    const pending = s.git.request(machine, 'status', 'sess', '/repo', {});
    s.git.onFrame(machine, { t: 'git.res', id: 'g-1', ok: true, result: showResult });
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('remote.git C2 method (CON-45 G2)', () => {
  const peer = { name: 'app' };
  const good = { machineId: machine, sessionId: 'sess', root: '/repo', op: 'status' };
  const fault = (f: () => unknown): unknown => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  };
  const d = () => ({ git: setup({}).git, peer });

  it.each([
    ['no machineId', { ...good, machineId: undefined }],
    ['an empty sessionId', { ...good, sessionId: '' }],
    ['a root past 4096 chars', { ...good, root: 'r'.repeat(4097) }],
    ['an unknown op', { ...good, op: 'push' }],
    ['no args for show', { ...good, op: 'show' }],
    ['a show without sha', { ...good, op: 'show', args: {} }],
    ['a show with a short sha', { ...good, op: 'show', args: { sha: 'abc' } }],
    ['a show with an uppercase sha', { ...good, op: 'show', args: { sha: 'ABC1234' } }],
    ['a log limit of 501', { ...good, op: 'log', args: { limit: 501 } }],
    ['a log limit of 0', { ...good, op: 'log', args: { limit: 0 } }],
    ['a log limit that is not whole', { ...good, op: 'log', args: { limit: 1.5 } }],
    ['a log before that is not a sha', { ...good, op: 'log', args: { before: 'zz' } }],
    ['a diff without path', { ...good, op: 'diff', args: {} }],
    ['a diff path past 4096 chars', { ...good, op: 'diff', args: { path: 'p'.repeat(4097) } }],
    ['args that are not a record', { ...good, args: 'x' }],
    ['status with args', { ...good, args: { path: 'a.ts' } }],
    ['a diff with a show sha', { ...good, op: 'diff', args: { path: 'a.ts', sha: 'abc1234' } }],
  ])('remote.git refuses bad params as invalid: %s', (_label, params) => {
    expect(fault(() => handleGitCall('remote.git', params, d()))).toMatchObject({
      kind: 'invalid',
    });
  });

  it('remote.git sends the checked args and answers B result', () => {
    const s = setup({});
    const out = handleGitCall(
      'remote.git',
      { ...good, op: 'log', args: { limit: 500 }, extra: 'ignored' },
      { git: s.git },
    );
    expect(s.sent[0]?.frame).toMatchObject({
      t: 'git.req',
      op: 'log',
      root: '/repo',
      args: { limit: 500 },
    });
    expect(out).toBeInstanceOf(Promise);
  });
});
