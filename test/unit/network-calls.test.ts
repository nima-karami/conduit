import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import { CALL_REFUSAL_AUDIT_MS, type CallFrame, createCalls } from '../../server/network/calls';
import type { McpNetworkPort } from '../../src/conduit-mcp/remote-routing';
import { toolError } from '../../src/conduit-mcp/types';
import { type LinkFrame, OWN_DEFAULT_CAPABILITIES } from '../../src/contracts/link-protocol';
import type { LinkRecord } from '../../src/network/link-file';

// B serves a routed call only from an inbound ssh controller link, as that lead's principal (CON-40
// S2, plan decision 4). The frame names a handle; the machine always comes from the link.

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
}) {
  const clock = opts.clock ?? { t: 1_000_000 };
  const sent: Array<{ machineId: string; frame: LinkFrame }> = [];
  const audit: AuditEvent[] = [];
  const callAsRemote = vi.fn<McpNetworkPort['callAsRemote']>(async () => ({
    ok: true,
    value: { agents: [] },
  }));
  const mcp = opts.mcp === undefined ? { callAsRemote } : opts.mcp;
  const calls = createCalls({
    linkOf: () => (opts.link === undefined ? sshController() : opts.link),
    mcp: () => mcp,
    send: (machineId, frame) => {
      sent.push({ machineId, frame });
      return true;
    },
    audit: { record: (e) => audit.push(e) },
    now: () => clock.t,
  });
  return { calls, sent, audit, callAsRemote, clock };
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
