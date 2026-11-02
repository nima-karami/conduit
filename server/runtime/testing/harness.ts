import type { HcClient } from '../../../src/contracts/hc';
import type { TokenRows, TokenStorePort } from '../../../src/contracts/server-ports';
import type { ConduitLabels, TokenRecord } from '../../../src/contracts/session-identity';
import type { LaunchIds, RuntimeEvent } from '../../../src/contracts/terminal-runtime';
import { NodeHcClient } from '../../../src/hc-client';
import { FakeHc } from '../../../src/hc-client/testing/fake-hc';
import type { TermGeometry } from '../../../src/protocol';
import { type HcRuntimeDeps, HcTerminalRuntime } from '../runtime';

export const INSTANCE = 'inst';

/** TokenStorePort over an in-memory row list, recording every call in order. */
class MemTokens implements TokenStorePort {
  list: TokenRecord[] = [];
  state: TokenRows['state'] = 'loaded';
  readonly calls: string[] = [];

  row(launchId: string): TokenRecord | undefined {
    return this.list.find((r) => r.launchId === launchId);
  }
  add(sessionId: string, ids: LaunchIds, state: TokenRecord['state'], hcAddress: string | null) {
    this.list.push({
      sessionId,
      sha256: 'hash',
      generation: ids.generation,
      launchId: ids.launchId,
      state,
      hcAddress,
      createdAt: '2026-11-02T00:00:00.000Z',
    });
  }
  async reserve(sessionId: string, ids: LaunchIds) {
    this.add(sessionId, ids, 'reserved', null);
    return { token: 'token' };
  }
  async resolveAddress(launchId: string, hcAddress: string) {
    this.calls.push(`resolve ${launchId} ${hcAddress}`);
    const row = this.row(launchId);
    if (row) Object.assign(row, { state: 'live', hcAddress });
  }
  async markUnconfirmed(launchId: string) {
    this.calls.push(`unconfirmed ${launchId}`);
    const row = this.row(launchId);
    if (row) row.state = 'unconfirmed';
  }
  async markSuperseded(launchId: string) {
    this.calls.push(`superseded ${launchId}`);
    const row = this.row(launchId);
    if (row) row.state = 'superseded';
  }
  rows(): TokenRows {
    if (this.state === 'loaded') return { state: 'loaded', rows: this.list.map((r) => ({ ...r })) };
    return { state: this.state };
  }
  async revoke(key: { sessionId: string } | { launchId: string }) {
    this.calls.push(`revoke ${'launchId' in key ? key.launchId : key.sessionId}`);
    this.list = this.list.filter((r) =>
      'launchId' in key ? r.launchId !== key.launchId : r.sessionId !== key.sessionId,
    );
  }
}

export const launch = (n: number): LaunchIds => ({
  generation: n,
  launchId: n.toString(16).padStart(32, '0'),
});

export const labelsFor = (sessionId: string, ids: LaunchIds): ConduitLabels => ({
  'conduit.session': sessionId,
  'conduit.instance': INSTANCE,
  'conduit.generation': String(ids.generation),
  'conduit.launch': ids.launchId,
  'conduit.role': 'session',
});

class Ring {
  readonly appended: Array<{ sessionId: string; data: string; size?: TermGeometry }> = [];
  readonly gaps: Array<{ sessionId: string; paint: string; size: TermGeometry }> = [];
  append(sessionId: string, data: string, size: TermGeometry | undefined) {
    this.appended.push({ sessionId, data, ...(size ? { size } : {}) });
  }
  gap(sessionId: string, paint: string, size: TermGeometry) {
    this.gaps.push({ sessionId, paint, size });
  }
  resized(sessionId: string, size: TermGeometry) {
    this.appended.push({ sessionId, data: '', size });
  }
  readonly launches: string[] = [];
  onLaunch?: () => void;
  launchStarted(sessionId: string) {
    this.launches.push(sessionId);
    this.onLaunch?.();
  }
  text(sessionId: string) {
    return this.appended
      .filter((a) => a.sessionId === sessionId)
      .map((a) => a.data)
      .join('');
  }
}

export interface Harness {
  fake: FakeHc;
  hc: NodeHcClient;
  tokens: MemTokens;
  ring: Ring;
  runtime: HcTerminalRuntime;
  events: RuntimeEvent[];
  logs: string[];
  /** Channels of every terminal.attach reply, in order. */
  attachChannels: number[];
  /** Runs before each terminal.attach leaves the runtime: holds or reorders it against hc events. */
  beforeAttach?: () => Promise<void>;
  close(): Promise<void>;
}

export async function harness(overrides: Partial<HcRuntimeDeps> = {}): Promise<Harness> {
  const fake = new FakeHc();
  await fake.listen();
  const attachChannels: number[] = [];
  fake.afterReply = (method, result) => {
    if (method === 'terminal.attach') attachChannels.push((result as { channel: number }).channel);
  };
  const hc = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10, log: () => {} });
  const tokens = new MemTokens();
  const ring = new Ring();
  const logs: string[] = [];
  let h: Harness | undefined;
  const port: HcClient = {
    call: (method, params) => hc.call(method, params),
    attach: async (params) => {
      await h?.beforeAttach?.();
      return hc.attach(params);
    },
    subscribe: (params, notify) => hc.subscribe(params, notify),
    onConnection: (listener) => hc.onConnection(listener),
    close: () => hc.close(),
  };
  const runtime = new HcTerminalRuntime({
    hc: port,
    tokens,
    ring,
    instance: INSTANCE,
    hcSession: 'conduit-test',
    appVersion: '9.9.9',
    logPath: 'server.log',
    log: (m) => logs.push(m),
    launchSettleMs: 50,
    ...overrides,
  });
  const events: RuntimeEvent[] = [];
  runtime.on((e) => events.push(e));
  h = {
    fake,
    hc,
    tokens,
    ring,
    runtime,
    events,
    logs,
    attachChannels,
    async close() {
      await runtime.close();
      await fake.close();
    },
  };
  return h;
}

/** The same labels as hc reports them on a terminal record. */
export const hcLabelsFor = (sessionId: string, ids: LaunchIds): Record<string, string> =>
  Object.fromEntries(Object.entries(labelsFor(sessionId, ids)));
