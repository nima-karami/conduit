import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import {
  CALL_REFUSAL_AUDIT_MS,
  type CallFrame,
  createCalls,
  ROUTED_CALL_MS,
} from '../../server/network/calls';
import type { McpNetworkPort } from '../../src/conduit-mcp/remote-routing';
import { toolError } from '../../src/conduit-mcp/types';
import {
  type LinkFrame,
  type LinkState,
  OWN_DEFAULT_CAPABILITIES,
} from '../../src/contracts/link-protocol';
import type { LinkRecord } from '../../src/network/link-file';

// B serves a routed call only from an inbound ssh controller link, as that lead's principal (CON-40
// S2, plan decision 4). The frame names a handle; the machine always comes from the link.
// A routes a call to a peer it dialed over ssh, and takes its answer back only from that peer (CON-40 S3).

const machine = 'm-12345678';
const sshController = (over: Partial<LinkRecord> = {}): LinkRecord => ({
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
const dialedSsh = (over: Partial<LinkRecord> = {}): LinkRecord =>
  sshController({ ssh: { target: 'h', node: 'n', mainJs: 'm', userData: 'u' }, ...over });

const call = (over: Partial<CallFrame> = {}): CallFrame => ({
  t: 'call',
  id: 'c-1',
  tool: 'list_agents',
  args: {},
  principal: { handle: 'claude-3' },
  ...over,
});

function setup(opts: {
  link?: LinkRecord | null;
  mcp?: Pick<McpNetworkPort, 'callAsRemote'> | null;
  clock?: { t: number };
  state?: LinkState | null;
  minor?: number | null;
  sendOk?: boolean | null;
}) {
  const clock = opts.clock ?? { t: 1_000_000 };
  const sent: Array<{ machineId: string; frame: LinkFrame }> = [];
  const audit: AuditEvent[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const logs: Array<{ message: string; data: Record<string, unknown> }> = [];
  let link: LinkRecord | null = opts.link === undefined ? sshController() : opts.link;
  let state: LinkState | null = opts.state === undefined ? 'up' : opts.state;
  let minor: number | null = opts.minor === undefined ? 2 : opts.minor;
  let n = 0;
  const callAsRemote = vi.fn<McpNetworkPort['callAsRemote']>(async () => ({
    ok: true,
    value: { agents: [] },
  }));
  const mcp = opts.mcp === undefined ? { callAsRemote } : opts.mcp;
  const calls = createCalls({
    linkOf: () => link,
    mcp: () => mcp,
    send: (machineId, frame) => {
      sent.push({ machineId, frame });
      return opts.sendOk === undefined ? true : opts.sendOk;
    },
    audit: { record: (e) => audit.push(e) },
    now: () => clock.t,
    linkState: () => state,
    peerMinor: () => minor,
    newId: () => `r-${++n}`,
    log: (message, data) => logs.push({ message, data }),
    after: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  const fire = () => {
    for (const t of timers)
      if (!t.cancelled) {
        t.cancelled = true;
        t.fn();
      }
  };
  return {
    calls,
    sent,
    logs,
    audit,
    callAsRemote,
    clock,
    timers,
    fire,
    setLink: (next: LinkRecord | null) => {
      link = next;
    },
    setState: (next: LinkState | null) => {
      state = next;
    },
    setMinor: (next: number | null) => {
      minor = next;
    },
  };
}

describe('serveCall: who may call', () => {
  it('refuses a call from a link the peer dialed, or a tls link, and audits it', async () => {
    for (const link of [
      sshController({ transport: 'tls', cert: 'pem' }),
      sshController({ ssh: { target: 'h', node: 'n', mainJs: 'm', userData: 'u' } }),
    ]) {
      const s = setup({ link });
      await s.calls.serveCall(machine, call());
      expect(s.callAsRemote).not.toHaveBeenCalled();
      expect(s.sent).toEqual([
        {
          machineId: machine,
          frame: {
            t: 'call.result',
            id: 'c-1',
            ok: false,
            error: {
              code: 'refused',
              message: 'calls are served only to an ssh controller',
              retryable: false,
            },
          },
        },
      ]);
      expect(s.audit).toEqual([
        { kind: 'call.refused', peer: machine, detail: { reason: 'not_controller' } },
      ]);
    }
  });

  it('refuses a link with no record at all', async () => {
    const s = setup({ link: null });
    await s.calls.serveCall(machine, call());
    expect(s.callAsRemote).not.toHaveBeenCalled();
    expect(s.audit.map((e) => e.kind)).toEqual(['call.refused']);
  });

  it('refuses a principal handle that is not bare, and audits it', async () => {
    for (const handle of ['claude-3@m-12345678', 'Bad Handle', 'a\nb', '']) {
      const s = setup({});
      await s.calls.serveCall(machine, call({ principal: { handle } }));
      expect(s.callAsRemote).not.toHaveBeenCalled();
      expect(s.sent[0]?.frame).toMatchObject({ t: 'call.result', ok: false });
      expect(s.audit[0]).toMatchObject({ kind: 'call.refused', detail: { reason: 'bad_handle' } });
    }
  });

  it('audits a flood of refusals once a minute per link', async () => {
    const s = setup({ link: sshController({ transport: 'tls', cert: 'pem' }) });
    await s.calls.serveCall(machine, call({ id: 'a' }));
    await s.calls.serveCall(machine, call({ id: 'b' }));
    expect(s.sent).toHaveLength(2);
    expect(s.audit).toHaveLength(1);
    s.clock.t += CALL_REFUSAL_AUDIT_MS;
    await s.calls.serveCall(machine, call({ id: 'c' }));
    expect(s.audit).toHaveLength(2);
  });
});

describe('serveCall: the principal and the answer', () => {
  it('runs the call as the lead on the link, with the link machine and capabilities', async () => {
    const link = sshController({
      capabilities: { messaging: true, monitor: true, drive: false },
    });
    const s = setup({ link });
    await s.calls.serveCall(machine, call({ tool: 'open_session', args: { path: '/w' } }));
    expect(s.callAsRemote).toHaveBeenCalledWith(
      {
        kind: 'remote',
        handle: 'claude-3',
        machineId: machine,
        trust: 'own',
        controller: true,
        capabilities: { messaging: true, monitor: true, drive: false },
      },
      'open_session',
      { path: '/w' },
    );
  });

  it('answers a good call ok, with its result', async () => {
    const s = setup({});
    await s.calls.serveCall(machine, call());
    expect(s.sent).toEqual([
      {
        machineId: machine,
        frame: { t: 'call.result', id: 'c-1', ok: true, result: { agents: [] } },
      },
    ]);
  });

  it('maps a tool error to call.result, with its hint', async () => {
    const callAsRemote = vi.fn<McpNetworkPort['callAsRemote']>(async () => ({
      ok: false,
      error: toolError('refused', 'no', undefined, {
        hint: 'answer it there',
        reason: 'remote_ask',
      }),
    }));
    const s = setup({ mcp: { callAsRemote } });
    await s.calls.serveCall(machine, call());
    expect(s.sent[0]?.frame).toEqual({
      t: 'call.result',
      id: 'c-1',
      ok: false,
      error: { code: 'refused', message: 'no', retryable: false, hint: 'answer it there' },
    });
  });

  it('cuts control characters out of the error text', async () => {
    const callAsRemote = vi.fn<McpNetworkPort['callAsRemote']>(async () => ({
      ok: false,
      error: toolError('denied', 'bad\u0007text'),
    }));
    const s = setup({ mcp: { callAsRemote } });
    await s.calls.serveCall(machine, call());
    expect(s.sent[0]?.frame).toMatchObject({ error: { message: 'badtext' } });
  });

  it('answers host_unavailable when no host is up yet', async () => {
    const s = setup({ mcp: null });
    await s.calls.serveCall(machine, call());
    expect(s.sent[0]?.frame).toMatchObject({
      t: 'call.result',
      ok: false,
      error: { code: 'host_unavailable' },
    });
  });

  it('answers too_large for a result the frame cannot carry', async () => {
    const callAsRemote = vi.fn<McpNetworkPort['callAsRemote']>(async () => ({
      ok: true,
      value: { text: 'x'.repeat(16 * 1024 * 1024) },
    }));
    const s = setup({ mcp: { callAsRemote } });
    await s.calls.serveCall(machine, call());
    expect(s.sent[0]?.frame).toMatchObject({ ok: false, error: { code: 'too_large' } });
  });
});

describe('call: the A-side router (CON-40 S3, plan decision 1 and 5)', () => {
  const ask = { tool: 'list_agents' as const, args: { x: 1 }, principal: 'claude-3' };
  const never = new AbortController().signal;
  const okResult = (id: string) => ({
    t: 'call.result' as const,
    id,
    ok: true as const,
    result: { agents: [{ id: 'echo' }] },
  });

  it('sends a call frame to the dialed peer and resolves with its result', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(s.sent).toEqual([
      {
        machineId: machine,
        frame: {
          t: 'call',
          id: 'r-1',
          tool: 'list_agents',
          args: { x: 1 },
          principal: { handle: 'claude-3' },
        },
      },
    ]);
    s.calls.onResult(machine, okResult('r-1'));
    expect(await pending).toEqual({ ok: true, value: { agents: [{ id: 'echo' }] } });
  });

  it('times out at the routed budget as peer_unreachable, never re-sends, and says B may have run it', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(s.timers.map((t) => t.ms)).toEqual([ROUTED_CALL_MS]);
    s.fire();
    const out = await pending;
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'peer_unreachable', retryable: false },
    });
    expect(s.sent).toHaveLength(1);
  });

  it('a drop rejects every pending call as peer_unreachable, and never re-sends it', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.setState('down');
    s.calls.linkChanged(machine);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
    expect(s.sent).toHaveLength(1);
    expect(s.timers.every((t) => t.cancelled)).toBe(true);
  });

  it('a revoke rejects pending calls as peer_revoked', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.setState('revoked');
    s.calls.linkChanged(machine);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_revoked' } });
  });

  it('a link that is degraded keeps its pending call; only a drop ends it', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.setState('degraded');
    s.calls.linkChanged(machine);
    s.calls.onResult(machine, okResult('r-1'));
    expect(await pending).toMatchObject({ ok: true });
  });

  it('a late result, after its timeout, is ignored', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.fire();
    expect((await pending).ok).toBe(false);
    s.calls.onResult(machine, okResult('r-1'));
    expect(s.sent).toHaveLength(1);
  });

  it('a second result for the same id is ignored', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.calls.onResult(machine, okResult('r-1'));
    s.calls.onResult(machine, {
      t: 'call.result',
      id: 'r-1',
      ok: false,
      error: { code: 'denied', message: 'late', retryable: false },
    });
    expect(await pending).toMatchObject({ ok: true });
  });

  it('a result from another machine is ignored and the call still waits for its own', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.calls.onResult('m-99999999', okResult('r-1'));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    s.calls.onResult(machine, okResult('r-1'));
    expect(await pending).toMatchObject({ ok: true });
  });

  it('a result over a peer that is not an ssh record we dialed is ignored', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.setLink(sshController());
    s.calls.onResult(machine, okResult('r-1'));
    s.fire();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
  });

  it('a peer below minor 2 is peer_incompatible, with a hint to update it, and nothing is sent', async () => {
    const s = setup({ link: dialedSsh(), minor: 1 });
    const out = await s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'peer_incompatible', hint: 'update Conduit on laptop' },
    });
    expect(s.sent).toEqual([]);
  });

  it('a link that is not up is peer_unreachable, with a hint to connect the machine first', async () => {
    for (const state of ['down', 'connecting', null] as const) {
      const s = setup({ link: dialedSsh(), state });
      const out = await s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
      expect(out).toMatchObject({
        ok: false,
        error: { code: 'peer_unreachable', hint: 'connect_machine laptop first' },
      });
      expect(s.sent).toEqual([]);
    }
  });

  it('a degraded link refuses a new call with a hint to try again, not to connect', async () => {
    const s = setup({ link: dialedSsh(), state: 'degraded' });
    const out = await s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(out).toMatchObject({
      ok: false,
      error: {
        code: 'peer_unreachable',
        message: 'the link to laptop is degraded',
        hint: 'try again shortly; the call was not sent',
      },
    });
    expect(s.sent).toEqual([]);
  });

  it('a revoked link is peer_revoked before anything is sent', async () => {
    const s = setup({ link: dialedSsh(), state: 'revoked' });
    const out = await s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(out).toMatchObject({ ok: false, error: { code: 'peer_revoked' } });
    expect(s.sent).toEqual([]);
  });

  it('a machine we did not dial over ssh is peer_unsupported, and nothing is sent', async () => {
    const s = setup({ link: sshController({ transport: 'tls', cert: 'pem' }) });
    const out = await s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(out).toMatchObject({ ok: false, error: { code: 'peer_unsupported' } });
    expect(s.sent).toEqual([]);
  });

  it('a link that refuses the frame at once is peer_unreachable, not a pending call', async () => {
    const s = setup({ link: dialedSsh(), sendOk: null });
    const out = await s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(out).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
    expect(s.timers.every((t) => t.cancelled)).toBe(true);
  });

  it('an abort ends the wait as cancelled, and a later result is ignored', async () => {
    const s = setup({ link: dialedSsh() });
    const ctl = new AbortController();
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, ctl.signal);
    ctl.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    s.calls.onResult(machine, okResult('r-1'));
    expect(s.sent).toHaveLength(1);
  });

  it('maps a remote error back to a tool error, with its code, hint and retryable', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.calls.onResult(machine, {
      t: 'call.result',
      id: 'r-1',
      ok: false,
      error: { code: 'out_of_reach', message: 'outside', retryable: false, hint: 'widen it' },
    });
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'out_of_reach', message: 'outside', retryable: false, hint: 'widen it' },
    });
  });

  it('a remote code this side does not know is refused, keeping its message', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.calls.onResult(machine, {
      t: 'call.result',
      id: 'r-1',
      ok: false,
      error: { code: 'from_the_future', message: 'new thing', retryable: false },
    });
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'refused', message: 'new thing' },
    });
  });

  it('stop rejects everything still pending as peer_unreachable', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.calls.stop();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_unreachable' } });
  });
});

describe('the router keeps its pending calls honest (CON-40 S3 review)', () => {
  const ask = { tool: 'list_agents' as const, args: { x: 1 }, principal: 'claude-3' };
  const never = new AbortController().signal;
  const okResult = (id: string) => ({
    t: 'call.result' as const,
    id,
    ok: true as const,
    result: { agents: [] },
  });

  it('a settled call leaves the pending map: a timeout, an answer or an abort each clear it', async () => {
    const timedOut = setup({ link: dialedSsh() });
    const p1 = timedOut.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    expect(timedOut.calls.pendingCount()).toBe(1);
    timedOut.fire();
    await p1;
    expect(timedOut.calls.pendingCount()).toBe(0);

    const answered = setup({ link: dialedSsh() });
    const p2 = answered.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    answered.calls.onResult(machine, okResult('r-1'));
    await p2;
    expect(answered.calls.pendingCount()).toBe(0);

    const aborted = setup({ link: dialedSsh() });
    const ctl = new AbortController();
    const p3 = aborted.calls.call(machine, ask.tool, ask.args, ask.principal, ctl.signal);
    ctl.abort();
    await p3;
    expect(aborted.calls.pendingCount()).toBe(0);
  });

  it('refuses arguments over the 64 KiB a routed call carries, and sends nothing', async () => {
    const s = setup({ link: dialedSsh() });
    const out = await s.calls.call(
      machine,
      ask.tool,
      { text: 'x'.repeat(64 * 1024 + 1) },
      ask.principal,
      never,
    );
    expect(out).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(s.sent).toEqual([]);
    expect(s.calls.pendingCount()).toBe(0);
  });

  it('an already-aborted signal sends nothing and does not wait out the budget', async () => {
    const s = setup({ link: dialedSsh() });
    const ctl = new AbortController();
    ctl.abort();
    const out = await s.calls.call(machine, ask.tool, ask.args, ask.principal, ctl.signal);
    expect(out).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(s.sent).toEqual([]);
    expect(s.timers).toEqual([]);
  });

  it('a machine that drops out of the link list ends its pending calls as peer_revoked', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.calls.settleAbsent(['m-99999999']);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_revoked' } });
    expect(s.sent).toHaveLength(1);
  });

  it('a removed record (no link state at all) ends its pending calls as peer_revoked, at once', async () => {
    const s = setup({ link: dialedSsh() });
    const pending = s.calls.call(machine, ask.tool, ask.args, ask.principal, never);
    s.setState(null);
    s.calls.linkChanged(machine);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'peer_revoked' } });
  });

  it('logs a routed call as it starts being served, before it runs', async () => {
    const s = setup({});
    await s.calls.serveCall(machine, call({ tool: 'open_session', args: { path: '/w' } }));
    expect(s.logs).toEqual([
      {
        message: 'routed call serving',
        data: { machineId: machine, tool: 'open_session', id: 'c-1' },
      },
    ]);
  });
});
