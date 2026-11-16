import { describe, expect, it } from 'vitest';
import {
  type ControlCallContext,
  type ControlHandlers,
  fail,
  isFail,
  type Prepared,
} from '../../src/conduit-mcp/control-tools';
import {
  CONNECT_BUDGET_MS,
  createMachineTools,
  type MachineToolDeps,
} from '../../src/conduit-mcp/machine-tools';
import type { NetworkPort } from '../../src/conduit-mcp/remote-routing';
import { toolSchemas } from '../../src/conduit-mcp/tool-schemas';
import type { Caller } from '../../src/conduit-mcp/tools';
import type { Result } from '../../src/conduit-mcp/types';
import type {
  ConnectMachineOk,
  ConnectMachineResult,
  DisconnectMachineResult,
  MachineView,
} from '../../src/contracts/machines';

const CALLER: Caller = { handle: 'claude-1', sessionId: 's1' };
const VIEW: MachineView = {
  machine: 'win-box',
  machine_id: 'm-0000000a',
  target: 'win-box',
  state: 'up',
  mode: 'full',
  os: 'windows',
  arch: 'x64',
  conduit_version: '1.4.0',
  agents: ['claude'],
  sessions: 2,
  last_seen: '2026-11-16T10:00:00.000Z',
  survives_logout: true,
};
const OK: ConnectMachineOk = {
  machine: 'win-box',
  machine_id: 'm-0000000a',
  state: 'up',
  os: 'windows',
  arch: 'x64',
  mode: 'full',
  conduit_version: '1.4.0',
  reused: true,
  installed: false,
  upgraded: false,
};

/** The pipeline the host gives control tools, minus the rate budget and the ask. */
const prepared: ControlHandlers['prepared'] = async (_tool, _caller, check) => {
  const c = await check({
    sessionId: 's1',
    home: '/w',
    spend: () => ({ refund: () => undefined, keep: () => undefined }),
  });
  if ('done' in c) return { ok: true, value: { done: c.done } };
  if (isFail(c)) return c;
  const token = { refund: () => undefined, keep: () => undefined };
  return {
    ok: true,
    value: {
      summary: c.summary,
      routesUi: false,
      alwaysAsk: c.alwaysAsk === true,
      budget: c.budget,
      run: async () => {
        try {
          return await c.exec(token);
        } finally {
          c.budget?.dispose();
        }
      },
      release: () => undefined,
    },
  };
};

function portWith(over: Partial<NetworkPort>): NetworkPort {
  const unused = (): never => {
    throw new Error('not used by the machine tools');
  };
  return {
    remoteEntries: unused,
    resolve: unused,
    enqueue: unused,
    waitReading: unused,
    peerCapabilitiesOf: unused,
    onChange: unused,
    call: unused,
    listMachines: () => [],
    connectMachine: async () => ({ ok: true, value: OK }),
    disconnectMachine: async () => ({ ok: true, value: { machine: 'win-box', state: 'down' } }),
    selfName: () => 'this-machine',
    answerRemoteRequest: () => Promise.reject(new Error('not used by this test')),
    pushPolicy: () => Promise.reject(new Error('not used by this test')),
    revokeRemoteGrant: () => Promise.reject(new Error('not used by this test')),
    ...over,
  };
}

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function rig(network: NetworkPort | undefined) {
  const timers: Timer[] = [];
  const deps: MachineToolDeps = {
    network: () => network,
    now: () => 0,
    setTimer: (fn, ms) => {
      const t: Timer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (handle) => {
      if (handle !== undefined) (handle as Timer).cleared = true;
    },
  };
  const tools = createMachineTools(deps, prepared);
  const ctx = (signal: AbortSignal): ControlCallContext => ({
    move: undefined,
    reach: undefined,
    signal,
    ui: async () => fail('window_not_ready', 'no window in this test'),
  });
  return { tools, timers, ctx };
}

/** Prepare, then run: a result known without acting is returned as it is. */
async function runOf<T>(r: Result<Prepared<T>>): Promise<Result<T>> {
  if (!r.ok) return r;
  const p = r.value;
  if ('done' in p) return p.done;
  return p.run();
}

describe('list_machines', () => {
  it('returns the pinned machines as an object, one view each (MCP structuredContent is an object)', async () => {
    const { tools } = rig(portWith({ listMachines: () => [VIEW] }));
    expect(await runOf(await tools.prepareListMachines(CALLER, {}))).toEqual({
      ok: true,
      value: { machines: [VIEW] },
    });
  });

  it('takes no arguments', async () => {
    const { tools } = rig(portWith({}));
    const r = await runOf(await tools.prepareListMachines(CALLER, { extra: true }));
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
  });

  it('without a network every machine tool says host_unavailable, not an empty list', async () => {
    const { tools } = rig(undefined);
    const r = await runOf(await tools.prepareListMachines(CALLER, {}));
    expect(r).toMatchObject({ ok: false, error: { code: 'host_unavailable' } });
  });
});

describe('connect_machine', () => {
  it('passes the machine to the network and returns its result', async () => {
    const seen: string[] = [];
    const { tools, ctx } = rig(
      portWith({
        connectMachine: async (machine) => {
          seen.push(machine);
          return { ok: true, value: OK };
        },
      }),
    );
    const r = await runOf(
      await tools.prepareConnectMachine(
        CALLER,
        { machine: 'win-box' },
        ctx(new AbortController().signal),
      ),
    );
    expect(r).toEqual({ ok: true, value: OK });
    expect(seen).toEqual(['win-box']);
  });

  it('maps a network error through machineToolError, with its hint', async () => {
    const { tools, ctx } = rig(
      portWith({
        connectMachine: async () => ({
          ok: false,
          error: { code: 'ssh_needs_person', detail: { reason: 'host_key_unknown' } },
        }),
      }),
    );
    const r = await runOf(
      await tools.prepareConnectMachine(
        CALLER,
        { machine: 'win-box' },
        ctx(new AbortController().signal),
      ),
    );
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: 'ssh_needs_person',
        hint: 'ask the human to connect win-box once from Machines',
        retryable: false,
      },
    });
  });

  it('a machine that is not yet added is shown as a new one in its ask', async () => {
    const { tools, ctx } = rig(portWith({ listMachines: () => [VIEW] }));
    const signal = new AbortController().signal;
    const known = await tools.prepareConnectMachine(CALLER, { machine: 'win-box' }, ctx(signal));
    const fresh = await tools.prepareConnectMachine(
      CALLER,
      { machine: 'new.example' },
      ctx(signal),
    );
    expect(known).toMatchObject({ ok: true, value: { summary: { newMachine: false } } });
    expect(fresh).toMatchObject({ ok: true, value: { summary: { newMachine: true } } });
  });

  it('a machine argument must be a non-empty string, and no other argument is accepted', async () => {
    const { tools, ctx } = rig(portWith({}));
    const signal = new AbortController().signal;
    for (const args of [{}, { machine: '' }, { machine: 3 }, { machine: 'a', extra: 1 }]) {
      expect(await tools.prepareConnectMachine(CALLER, args, ctx(signal))).toMatchObject({
        ok: false,
        error: { code: 'invalid_args' },
      });
    }
  });

  it('a connect that the network never answers ends at the 120 s budget as ssh_unreachable timeout', async () => {
    let seenSignal: AbortSignal | null = null;
    const { tools, timers, ctx } = rig(
      portWith({
        connectMachine: (_machine, signal) => {
          seenSignal = signal;
          // A dial that ignores its signal: the tool still answers at the budget.
          return new Promise<ConnectMachineResult>(() => undefined);
        },
      }),
    );
    const prep = await tools.prepareConnectMachine(
      CALLER,
      { machine: 'win-box' },
      ctx(new AbortController().signal),
    );
    if (!prep.ok || 'done' in prep.value) throw new Error('expected a call to run');
    const pending = prep.value.run();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(CONNECT_BUDGET_MS);
    expect(CONNECT_BUDGET_MS).toBe(120_000);
    timers[0].fn();
    expect(await pending).toMatchObject({
      ok: false,
      error: {
        code: 'ssh_unreachable',
        hint: 'the machine may be asleep or offline; try again shortly',
      },
    });
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('the budget timer is cleared once the connect answers in time', async () => {
    const { tools, timers, ctx } = rig(portWith({}));
    const prep = await tools.prepareConnectMachine(
      CALLER,
      { machine: 'win-box' },
      ctx(new AbortController().signal),
    );
    await runOf(prep);
    expect(timers).toHaveLength(1);
    expect(timers[0].cleared).toBe(true);
  });

  it('cancelling the call aborts the dial it started', async () => {
    let seenSignal: AbortSignal | null = null;
    const { tools, ctx } = rig(
      portWith({
        connectMachine: (_machine, signal) => {
          seenSignal = signal;
          return new Promise<ConnectMachineResult>(() => undefined);
        },
      }),
    );
    const cancel = new AbortController();
    const prep = await tools.prepareConnectMachine(
      CALLER,
      { machine: 'win-box' },
      ctx(cancel.signal),
    );
    if (!prep.ok || 'done' in prep.value) throw new Error('expected a call to run');
    void prep.value.run();
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(false);
    cancel.abort();
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('without a network it says host_unavailable before any ask', async () => {
    const { tools, ctx } = rig(undefined);
    const r = await tools.prepareConnectMachine(
      CALLER,
      { machine: 'win-box' },
      ctx(new AbortController().signal),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'host_unavailable' } });
  });
});

describe('disconnect_machine', () => {
  it('returns the down state of the machine it closed', async () => {
    const { tools } = rig(portWith({}));
    expect(
      await runOf(await tools.prepareDisconnectMachine(CALLER, { machine: 'win-box' })),
    ).toEqual({ ok: true, value: { machine: 'win-box', state: 'down' } });
  });

  it('maps a network error, such as an unknown machine', async () => {
    const result: DisconnectMachineResult = {
      ok: false,
      error: { code: 'machine_unknown', detail: {} },
    };
    const { tools } = rig(portWith({ disconnectMachine: async () => result }));
    expect(
      await runOf(await tools.prepareDisconnectMachine(CALLER, { machine: 'nope' })),
    ).toMatchObject({ ok: false, error: { code: 'machine_unknown' } });
  });

  it('without a network it says host_unavailable', async () => {
    const { tools } = rig(undefined);
    expect(
      await runOf(await tools.prepareDisconnectMachine(CALLER, { machine: 'win-box' })),
    ).toMatchObject({ ok: false, error: { code: 'host_unavailable' } });
  });
});

describe('machine tool schemas (spec 5.1)', () => {
  const byName = (name: string) => {
    const s = toolSchemas().find((t) => t.name === name);
    if (!s) throw new Error(`no schema for ${name}`);
    return s;
  };

  it('list_machines takes no arguments', () => {
    const s = byName('list_machines');
    expect(s.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {},
    });
  });

  it.each(['connect_machine', 'disconnect_machine'])(
    '%s takes one non-empty machine string and nothing else',
    (name) => {
      const s = byName(name);
      expect(s.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['machine'],
        properties: { machine: { type: 'string' } },
      });
    },
  );

  it('every machine tool is in the catalog, in TOOL_NAMES order', () => {
    const names = toolSchemas().map((s) => s.name);
    expect(names.slice(-3)).toEqual(['list_machines', 'connect_machine', 'disconnect_machine']);
  });
});
