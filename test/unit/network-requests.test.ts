import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { CALL_REFUSAL_AUDIT_MS } from '../../server/network/calls';
import {
  type ApplyRemoteAnswerResult,
  createRequests,
  REMOTE_ANSWER_MS,
  type RequestMirrorSink,
  type RequestMirrorSource,
} from '../../server/network/requests';
import {
  type LinkFrame,
  type LinkState,
  OWN_DEFAULT_CAPABILITIES,
  type RequestMirror,
} from '../../src/contracts/link-protocol';
import type { LinkRecord } from '../../src/network/link-file';

// Remote requests over the ssh link (CON-42 L4, spec 5.3, plan decisions 1 and the Architecture).
// B mirrors its open requests only to an inbound ssh controller at protocol minor 3 and applies an
// answer only from such a link, under that link's machine id. A mirrors only from a machine it
// dialed over ssh, and answers are call-like: never re-sent, 30 s to answer, dropped at once.

const CTRL = 'm-ctrl0001';
const CTRL_OLD = 'm-ctrl0002';
const DIALED = 'm-dial0003';
const TLS = 'm-tls00004';

const linkRecord = (machineId: string, over: Partial<LinkRecord> = {}): LinkRecord => ({
  linkId: `l-${machineId}`,
  machineId,
  serverKey: 'key',
  ownerKey: null,
  name: `box-${machineId}`,
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
  ...over,
});
/** An inbound ssh controller: the peer dialed me over its own ssh session. */
const controller = (machineId: string) => linkRecord(machineId);
/** A machine I dialed over ssh. */
const dialed = (machineId: string) =>
  linkRecord(machineId, { ssh: { target: 'h', node: 'n', mainJs: 'm', userData: 'u' } });
/** A TLS peer, which may never receive a mirror or answer one. */
const tls = (machineId: string) => linkRecord(machineId, { transport: 'tls', cert: 'pem' });

const mirror = (over: Partial<RequestMirror> = {}): RequestMirror => ({
  id: 'r-1',
  kind: 'confirm',
  title: 'Run the build?',
  body: 'the agent wants to run it',
  options: [],
  multi: false,
  draft: null,
  priority: 'normal',
  createdAt: '2026-11-16T00:00:00.000Z',
  expiresAt: null,
  requester: 'claude-3@box',
  state: 'open',
  answer: null,
  permission: null,
  ...over,
});

type AnswerFrame = Extract<LinkFrame, { t: 'request.answer' }>;
type AnsweredFrame = Extract<LinkFrame, { t: 'request.answered' }>;
type MirrorFrame = Extract<LinkFrame, { t: 'request.mirror' }>;
const answerFrame = (over: Partial<AnswerFrame> = {}): AnswerFrame => ({
  t: 'request.answer',
  answerId: 'a-wire-1',
  requestId: 'r-1',
  answer: { outcome: 'confirm' },
  ...over,
});

interface Peer {
  record: LinkRecord;
  state: LinkState;
  minor: number | null;
}
interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

function setup(opts: { sendOk?: boolean | null } = {}) {
  const peers = new Map<string, Peer>();
  const sent: Array<{ machineId: string; frame: LinkFrame }> = [];
  const audit: AuditEvent[] = [];
  const timers: Timer[] = [];
  const clock = { t: 1_000_000 };
  let rows: RequestMirror[] = [mirror()];
  let ended = false;
  let sendOk: boolean | null = opts.sendOk === undefined ? true : opts.sendOk;
  let n = 0;
  const mirrorListeners = new Set<() => void>();

  const b = {
    mirrorOf: vi.fn<RequestMirrorSource['mirrorOf']>(() => rows),
    hasEnded: vi.fn<RequestMirrorSource['hasEnded']>(() => ended),
    onMirrorChange: vi.fn<RequestMirrorSource['onMirrorChange']>((fn) => {
      mirrorListeners.add(fn);
      return () => {
        mirrorListeners.delete(fn);
      };
    }),
    applyRemoteAnswer: vi.fn<RequestMirrorSource['applyRemoteAnswer']>(
      async (): Promise<ApplyRemoteAnswerResult> => ({ ok: true }),
    ),
  } satisfies RequestMirrorSource;
  const a = {
    apply: vi.fn<RequestMirrorSink['apply']>(),
    setLinkState: vi.fn<RequestMirrorSink['setLinkState']>(),
  } satisfies RequestMirrorSink;

  const req = createRequests({
    b,
    a,
    links: () => [...peers].map(([machineId, p]) => ({ machineId, state: p.state })),
    linkOf: (machineId) => peers.get(machineId)?.record ?? null,
    peerMinor: (machineId) => peers.get(machineId)?.minor ?? null,
    send: (machineId, frame) => {
      sent.push({ machineId, frame });
      return sendOk;
    },
    audit: { record: (e) => audit.push(e) },
    now: () => clock.t,
    after: (fn, ms) => {
      const t: Timer = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    newId: () => `a-${++n}`,
  });

  /** Fires every timer still armed, as the clock passing its deadline would. */
  const fire = () => {
    for (const t of timers)
      if (!t.cancelled) {
        t.cancelled = true;
        t.fn();
      }
  };
  const frames = <T extends LinkFrame['t']>(t: T, machineId?: string) =>
    sent
      .filter((s) => s.frame.t === t && (machineId === undefined || s.machineId === machineId))
      .map((s) => s.frame as Extract<LinkFrame, { t: T }>);

  return {
    req,
    b,
    a,
    audit,
    sent,
    timers,
    clock,
    fire,
    frames,
    peers,
    /** Adds or replaces a peer's record, state and minor, as the link manager would hold them. */
    put(record: LinkRecord, state: LinkState, minor: number | null) {
      peers.set(record.machineId, { record, state, minor });
    },
    /** The link manager calls `changed` on every change a view would show. */
    setState(machineId: string, state: LinkState) {
      const p = peers.get(machineId);
      if (p) p.state = state;
    },
    remove(machineId: string) {
      peers.delete(machineId);
    },
    changed: () => req.linksChanged(),
    setRows(next: RequestMirror[]) {
      rows = next;
    },
    setEnded(next: boolean) {
      ended = next;
    },
    fireMirrorChange() {
      for (const fn of mirrorListeners) fn();
    },
    setSendOk(next: boolean | null) {
      sendOk = next;
    },
  };
}

describe('B: mirrors go only to inbound ssh controllers at minor 3', () => {
  it('sends the snapshot on up only to a controller at minor 3 or later', () => {
    const w = setup();
    w.put(controller(CTRL), 'connecting', 3);
    w.put(controller(CTRL_OLD), 'connecting', 2);
    w.put(dialed(DIALED), 'connecting', 3);
    w.put(tls(TLS), 'connecting', 3);
    for (const id of [CTRL, CTRL_OLD, DIALED, TLS]) w.setState(id, 'up');
    w.changed();
    expect(w.frames('request.mirror').map((f) => f.seq)).toHaveLength(1);
    expect(w.sent.filter((s) => s.frame.t === 'request.mirror').map((s) => s.machineId)).toEqual([
      CTRL,
    ]);
  });

  it('sends nothing to a controller whose hello has not landed', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', null);
    w.changed();
    expect(w.frames('request.mirror')).toEqual([]);
  });

  it('sends nothing to a controller that is not live', () => {
    const w = setup();
    w.put(controller(CTRL), 'down', 3);
    w.changed();
    w.fireMirrorChange();
    w.fire();
    expect(w.frames('request.mirror')).toEqual([]);
  });
});

describe('B: mirror snapshots are full on up, coalesced on change, and seq rises', () => {
  it('sends the full mirror on link up, carrying every row', () => {
    const w = setup();
    w.setRows([mirror({ id: 'r-1' }), mirror({ id: 'r-2', state: 'answered' })]);
    w.put(controller(CTRL), 'connecting', 3);
    w.setState(CTRL, 'up');
    w.changed();
    const [only] = w.frames('request.mirror');
    expect(only?.requests.map((r) => r.id)).toEqual(['r-1', 'r-2']);
  });

  it('coalesces a burst of changes into one send 250 ms after the first', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    w.sent.length = 0;
    w.fireMirrorChange();
    w.fireMirrorChange();
    w.fireMirrorChange();
    expect(w.frames('request.mirror')).toEqual([]);
    const armed = w.timers.filter((t) => !t.cancelled);
    expect(armed.map((t) => t.ms)).toEqual([250]);
    w.setRows([mirror({ id: 'r-9', title: 'latest' })]);
    w.fire();
    expect(w.frames('request.mirror')).toHaveLength(1);
    expect(w.frames('request.mirror')[0]?.requests.map((r) => r.id)).toEqual(['r-9']);
  });

  it('never sends a coalesced change to a link that is down', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    w.sent.length = 0;
    w.setState(CTRL, 'down');
    w.changed();
    w.fireMirrorChange();
    w.fire();
    expect(w.frames('request.mirror')).toEqual([]);
  });

  it('gives every send on a link a seq higher than the one before, even within one tick', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    w.fireMirrorChange();
    w.fire();
    w.fireMirrorChange();
    w.fire();
    const seqs = w.frames('request.mirror', CTRL).map((f) => f.seq);
    expect(seqs).toHaveLength(3);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0);
  });

  it('sends a fresh full snapshot with a higher seq after the link drops and comes back', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    const first = w.frames('request.mirror', CTRL)[0]?.seq ?? 0;
    w.setState(CTRL, 'down');
    w.changed();
    w.setState(CTRL, 'up');
    w.changed();
    const seqs = w.frames('request.mirror', CTRL).map((f) => f.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBeGreaterThan(first);
  });

  it('keeps a degraded controller mirrored (it is still live)', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    w.setState(CTRL, 'degraded');
    w.changed();
    expect(w.frames('request.mirror', CTRL)).toHaveLength(1);
  });
});

describe('B: an ended entry is re-sent every 60 s until it ages out of the window', () => {
  /** Fires the one armed timer of that length, without firing the timers it arms in turn. */
  const fireArmed = (w: ReturnType<typeof setup>, ms: number) => {
    const t = w.timers.find((x) => !x.cancelled && x.ms === ms);
    if (t === undefined) throw new Error(`no ${ms} ms timer armed`);
    t.cancelled = true;
    t.fn();
  };
  const armed = (w: ReturnType<typeof setup>) =>
    w.timers.filter((t) => !t.cancelled).map((t) => t.ms);

  it('re-sends the snapshot 60 s after the last one while an ended entry is held, then stops', () => {
    const w = setup();
    w.setEnded(true);
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    expect(armed(w)).toEqual([60_000]);
    fireArmed(w, 60_000);
    expect(w.frames('request.mirror', CTRL)).toHaveLength(2);
    expect(armed(w)).toEqual([60_000]);
    w.setEnded(false);
    fireArmed(w, 60_000);
    expect(w.frames('request.mirror', CTRL)).toHaveLength(3);
    expect(armed(w)).toEqual([]);
  });

  it('arms nothing when no entry has ended', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    expect(armed(w)).toEqual([]);
  });

  it('arms nothing when no controller is mirrorable, even with an ended entry', () => {
    const w = setup();
    w.setEnded(true);
    w.put(controller(CTRL), 'down', 3);
    w.changed();
    expect(armed(w)).toEqual([]);
  });

  it('restarts the 60 s clock on every snapshot, not only on the re-send', () => {
    const w = setup();
    w.setEnded(true);
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    w.fireMirrorChange();
    fireArmed(w, 250);
    expect(armed(w)).toEqual([60_000]);
  });

  it('cancels the pending re-send when the mirror stops', () => {
    const w = setup();
    w.setEnded(true);
    w.put(controller(CTRL), 'up', 3);
    w.changed();
    w.req.stop();
    expect(armed(w)).toEqual([]);
  });
});

describe('B: answers come only from an inbound ssh controller', () => {
  it('applies an answer under the link machine id, then replies request.answered ok', async () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    await w.req.onFrame(
      CTRL,
      answerFrame({ requestId: 'r-7', answer: { outcome: 'choose', values: ['yes'] } }),
    );
    expect(w.b.applyRemoteAnswer).toHaveBeenCalledWith(
      'r-7',
      { outcome: 'choose', values: ['yes'] },
      'a-wire-1',
      CTRL,
    );
    expect(w.sent).toEqual([
      { machineId: CTRL, frame: { t: 'request.answered', answerId: 'a-wire-1', ok: true } },
    ]);
  });

  it('refuses an answer from a link that is not an inbound controller, and audits it', async () => {
    for (const record of [tls(TLS), dialed(DIALED)]) {
      const w = setup();
      w.put(record, 'up', 3);
      await w.req.onFrame(record.machineId, answerFrame());
      expect(w.b.applyRemoteAnswer).not.toHaveBeenCalled();
      expect(w.sent).toEqual([
        {
          machineId: record.machineId,
          frame: {
            t: 'request.answered',
            answerId: 'a-wire-1',
            ok: false,
            error: {
              code: 'refused',
              message: 'answers are taken only from an ssh controller',
              retryable: false,
            },
          },
        },
      ]);
      expect(w.audit).toEqual([
        { kind: 'request.refused', peer: record.machineId, detail: { reason: 'not_controller' } },
      ]);
    }
  });

  it('audits a refused answer at most once per link per refusal window', async () => {
    const w = setup();
    w.put(tls(TLS), 'up', 3);
    await w.req.onFrame(TLS, answerFrame({ answerId: 'a-wire-1' }));
    await w.req.onFrame(TLS, answerFrame({ answerId: 'a-wire-2' }));
    expect(w.audit).toHaveLength(1);
    expect(w.frames('request.answered')).toHaveLength(2);
    w.clock.t += CALL_REFUSAL_AUDIT_MS;
    await w.req.onFrame(TLS, answerFrame({ answerId: 'a-wire-3' }));
    expect(w.audit).toHaveLength(2);
  });

  it('relays the apply failure to the controller as request.answered ok:false', async () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.b.applyRemoteAnswer.mockResolvedValueOnce({
      ok: false,
      error: { code: 'denied', message: 'the request is already answered', retryable: false },
    });
    await w.req.onFrame(CTRL, answerFrame());
    expect(w.sent).toEqual([
      {
        machineId: CTRL,
        frame: {
          t: 'request.answered',
          answerId: 'a-wire-1',
          ok: false,
          error: { code: 'denied', message: 'the request is already answered', retryable: false },
        },
      },
    ]);
  });
});

describe('A: mirrors are accepted only from machines I dialed', () => {
  const mirrorFrame = (seq: number, rows: RequestMirror[] = [mirror()]): MirrorFrame => ({
    t: 'request.mirror',
    seq,
    requests: rows,
  });

  it('applies a mirror from a dialed machine under its name', () => {
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    const rows = [mirror({ id: 'r-5' })];
    w.req.onFrame(DIALED, mirrorFrame(7, rows));
    expect(w.a.apply).toHaveBeenCalledWith(DIALED, 7, rows, `box-${DIALED}`);
  });

  it('ignores and audits a mirror from a controller or a TLS peer', () => {
    for (const record of [controller(CTRL), tls(TLS)]) {
      const w = setup();
      w.put(record, 'up', 3);
      w.req.onFrame(record.machineId, mirrorFrame(1));
      expect(w.a.apply).not.toHaveBeenCalled();
      expect(w.audit).toEqual([
        { kind: 'request.refused', peer: record.machineId, detail: { reason: 'not_dialed' } },
      ]);
    }
  });

  it('ignores a mirror from a machine with no record at all', () => {
    const w = setup();
    w.req.onFrame(DIALED, mirrorFrame(1));
    expect(w.a.apply).not.toHaveBeenCalled();
  });
});

describe('A: answering a remote request', () => {
  it('sends one request.answer under a fresh answerId and resolves ok on its request.answered', async () => {
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    const pending = w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
    expect(w.frames('request.answer', DIALED)).toEqual([
      { t: 'request.answer', answerId: 'a-1', requestId: 'r-1', answer: { outcome: 'confirm' } },
    ]);
    w.req.onFrame(DIALED, { t: 'request.answered', answerId: 'a-1', ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('resolves peer_unreachable after 30 s and ignores the late answer', async () => {
    expect(REMOTE_ANSWER_MS).toBe(30_000);
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    const pending = w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
    expect(w.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([30_000]);
    w.fire();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('peer_unreachable');
    expect(result.error.retryable).toBe(false);
    expect(w.req.pendingCount()).toBe(0);
    w.req.onFrame(DIALED, { t: 'request.answered', answerId: 'a-1', ok: true });
    expect(w.frames('request.answer')).toHaveLength(1);
  });

  it('gives peer_unreachable at once when the link drops, and never re-sends the answer', async () => {
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    const pending = w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
    w.setState(DIALED, 'down');
    w.changed();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('peer_unreachable');
    w.setState(DIALED, 'up');
    w.changed();
    expect(w.frames('request.answer')).toHaveLength(1);
  });

  it('gives peer_revoked at once when the machine is revoked or removed', async () => {
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    const pending = w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
    w.setState(DIALED, 'revoked');
    w.changed();
    const result = await pending;
    expect(result.ok ? null : result.error.code).toBe('peer_revoked');
  });

  it('refuses before sending when the link cannot take the answer', async () => {
    const cases: Array<{
      name: string;
      setup: (w: ReturnType<typeof setup>) => void;
      code: string;
    }> = [
      { name: 'no link', setup: () => {}, code: 'peer_unreachable' },
      {
        name: 'a minor below 3',
        setup: (w) => w.put(dialed(DIALED), 'up', 2),
        code: 'peer_incompatible',
      },
      {
        name: 'no hello yet',
        setup: (w) => w.put(dialed(DIALED), 'up', null),
        code: 'peer_unreachable',
      },
      {
        name: 'a link the peer dialed',
        setup: (w) => w.put(controller(DIALED), 'up', 3),
        code: 'peer_unsupported',
      },
      {
        name: 'a link that is connecting',
        setup: (w) => w.put(dialed(DIALED), 'connecting', 3),
        code: 'peer_unreachable',
      },
      {
        name: 'a degraded link',
        setup: (w) => w.put(dialed(DIALED), 'degraded', 3),
        code: 'peer_unreachable',
      },
    ];
    for (const c of cases) {
      const w = setup();
      c.setup(w);
      const result = await w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
      expect(result.ok, c.name).toBe(false);
      expect(result.ok ? null : result.error.code, c.name).toBe(c.code);
      expect(w.frames('request.answer'), c.name).toEqual([]);
    }
  });

  it('gives peer_unreachable when the send itself is refused, with nothing sent', async () => {
    const w = setup({ sendOk: null });
    w.put(dialed(DIALED), 'up', 3);
    const result = await w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
    expect(result.ok ? null : result.error.code).toBe('peer_unreachable');
    expect(w.req.pendingCount()).toBe(0);
  });

  it('ignores a request.answered for an unknown answerId or from another machine', async () => {
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    w.put(dialed(TLS), 'up', 3);
    const pending = w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
    const answered: AnsweredFrame = { t: 'request.answered', answerId: 'a-1', ok: true };
    w.req.onFrame(TLS, answered);
    w.req.onFrame(DIALED, { t: 'request.answered', answerId: 'a-unknown', ok: true });
    expect(w.req.pendingCount()).toBe(1);
    w.req.onFrame(DIALED, answered);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('a request.answered reports the peer error as given', async () => {
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    const pending = w.req.answerRemote(DIALED, 'r-1', { outcome: 'confirm' });
    w.req.onFrame(DIALED, {
      t: 'request.answered',
      answerId: 'a-1',
      ok: false,
      error: { code: 'approval_timeout', message: 'nobody answered', retryable: true },
    });
    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: 'approval_timeout', message: 'nobody answered', retryable: true },
    });
  });
});

describe('A: link state reaches the mirror store', () => {
  it('reports up, down and gone for machines I dialed, and only on a change', () => {
    const w = setup();
    w.put(dialed(DIALED), 'connecting', 3);
    w.changed();
    expect(w.a.setLinkState).toHaveBeenLastCalledWith(DIALED, 'down');
    w.setState(DIALED, 'up');
    w.changed();
    expect(w.a.setLinkState).toHaveBeenLastCalledWith(DIALED, 'up');
    w.changed();
    w.setState(DIALED, 'down');
    w.changed();
    expect(w.a.setLinkState).toHaveBeenLastCalledWith(DIALED, 'down');
    expect(w.a.setLinkState.mock.calls.map((c) => c[1])).toEqual(['down', 'up', 'down']);
  });

  it('treats a degraded link as up, and a revoked or removed one as gone', () => {
    const w = setup();
    w.put(dialed(DIALED), 'up', 3);
    w.changed();
    w.setState(DIALED, 'degraded');
    w.changed();
    expect(w.a.setLinkState).toHaveBeenLastCalledWith(DIALED, 'up');
    w.setState(DIALED, 'revoked');
    w.changed();
    expect(w.a.setLinkState).toHaveBeenLastCalledWith(DIALED, 'gone');
    w.put(dialed(TLS), 'up', 3);
    w.changed();
    w.remove(TLS);
    w.changed();
    expect(w.a.setLinkState).toHaveBeenLastCalledWith(TLS, 'gone');
  });

  it('does not report machines that dialed me', () => {
    const w = setup();
    w.put(controller(CTRL), 'up', 3);
    w.put(tls(TLS), 'up', 3);
    w.changed();
    expect(w.a.setLinkState).not.toHaveBeenCalled();
  });
});

it('preserves policy storage failure across answered wire frames without replay', async () => {
  const w = setup();
  w.put(controller(CTRL), 'up', 3);
  const error = {
    code: 'policy_unavailable',
    message: 'Permissions could not be saved (save-failed)',
    retryable: false,
  };
  w.b.applyRemoteAnswer.mockResolvedValueOnce({ ok: false, error });
  await w.req.onFrame(CTRL, answerFrame());
  expect(w.frames('request.answered')).toEqual([
    { t: 'request.answered', answerId: 'a-wire-1', ok: false, error },
  ]);
  const a = setup();
  a.put(dialed(DIALED), 'up', 3);
  const pending = a.req.answerRemote(DIALED, 'r-1', { outcome: 'allow', grant: true });
  await a.req.onFrame(DIALED, { t: 'request.answered', answerId: 'a-1', ok: false, error });
  await expect(pending).resolves.toEqual({ ok: false, error });
  a.fire();
  a.changed();
  expect(a.frames('request.answer')).toHaveLength(1);
});
