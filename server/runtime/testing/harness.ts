import type { HcClient } from '../../../src/contracts/hc';
import type { ConduitLabels } from '../../../src/contracts/session-identity';
import type { LaunchIds, RuntimeEvent } from '../../../src/contracts/terminal-runtime';
import { NodeHcClient } from '../../../src/hc-client';
import { FakeHc } from '../../../src/hc-client/testing/fake-hc';
import type { TermGeometry } from '../../../src/protocol';
import { type HcRuntimeDeps, HcTerminalRuntime } from '../runtime';
import { createTokenStore, type MemTokenStore } from './token-store';

export const INSTANCE = 'inst';

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
  tokens: MemTokenStore;
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
  const tokens = createTokenStore({ randomToken: () => 'token' });
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
