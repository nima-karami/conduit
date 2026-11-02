import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, ServerEvents } from '../../../src/contracts/server-protocol';
import type { ConduitLabels } from '../../../src/contracts/session-identity';
import type { FirstPaint } from '../../../src/contracts/terminal-link';
import type {
  AdoptedTerminal,
  LaunchIds,
  RuntimeEvent,
  RuntimeTerminal,
  SpawnResult,
  TerminalRuntime,
} from '../../../src/contracts/terminal-runtime';
import type { TermGeometry } from '../../../src/protocol';
import type { SubmitOutcome } from '../../../src/pty-writer';
import type { AgentDefinition, SpawnSpec } from '../../../src/types';
import { RpcFault } from '../../transport/pipe';
import { createDomain, type Domain, type DomainDeps } from '../index';

export interface SpawnCall {
  sessionId: string;
  spec: SpawnSpec;
  labels: ConduitLabels;
  ids: LaunchIds;
}

/** C1 for unit tests: spawns answer from `nextSpawn`, events are pushed with `fire`. */
export class FakeRuntime implements TerminalRuntime {
  readonly calls: string[] = [];
  readonly spawns: SpawnCall[] = [];
  readonly terminals = new Map<string, RuntimeTerminal>();
  readonly tails = new Map<string, string[]>();
  private listeners: ((e: RuntimeEvent) => void)[] = [];
  /** Default: a live terminal at 80x24. */
  nextSpawn?: (call: SpawnCall) => Promise<SpawnResult>;

  fire(e: RuntimeEvent): void {
    for (const l of this.listeners) l(e);
  }

  live(
    sessionId: string,
    generation: number,
    launchId: string,
    size: TermGeometry,
  ): RuntimeTerminal {
    const terminal: RuntimeTerminal = {
      sessionId,
      generation,
      launchId,
      state: 'live',
      size,
      target: { hcSession: 'conduit-test', terminal: `t-${launchId}` },
    };
    this.terminals.set(sessionId, terminal);
    return terminal;
  }

  async reconcile(): Promise<AdoptedTerminal[]> {
    return [];
  }
  async spawn(
    sessionId: string,
    spec: SpawnSpec,
    labels: ConduitLabels,
    ids: LaunchIds,
  ): Promise<SpawnResult> {
    this.calls.push('spawn');
    const call = { sessionId, spec, labels, ids };
    this.spawns.push(call);
    if (this.nextSpawn) return this.nextSpawn(call);
    const terminal = this.live(sessionId, ids.generation, ids.launchId, { cols: 80, rows: 24 });
    this.fire({ type: 'spawned', sessionId, generation: ids.generation, size: terminal.size });
    return { ok: true, terminal };
  }
  async discardLaunch(sessionId: string, launchId: string): Promise<void> {
    this.calls.push(`discardLaunch:${sessionId}:${launchId}`);
  }
  async beginStopping(): Promise<void> {}
  input(): boolean {
    return true;
  }
  resize(): void {}
  facts(): void {}
  get(sessionId: string): RuntimeTerminal | undefined {
    return this.terminals.get(sessionId);
  }
  async screen() {
    return null;
  }
  tailLines(sessionId: string, n: number): string[] {
    return (this.tails.get(sessionId) ?? []).slice(-n);
  }
  async kill(sessionId: string): Promise<void> {
    this.calls.push(`kill:${sessionId}`);
    this.terminals.delete(sessionId);
  }
  async retire(sessionId: string): Promise<void> {
    this.calls.push(`retire:${sessionId}`);
    this.terminals.delete(sessionId);
  }
  async close(): Promise<void> {}
  on(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

const SHELL: AgentDefinition = {
  id: 'sh',
  label: 'sh',
  command: 'sh',
  args: [],
  icon: 'terminal',
  color: 'terminal.ansiWhite',
  cwdStrategy: 'workspaceFolder',
};
const CLAUDE: AgentDefinition = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  args: [],
  icon: 'sparkle',
  color: 'terminal.ansiYellow',
  cwdStrategy: 'workspaceFolder',
};

export interface RecordedEvent {
  type: ServerEvent;
  data: unknown;
}

export interface HarnessOptions {
  /** Files written into userData before the domain is created. */
  files?: Record<string, string>;
  userData?: string;
  runtime?: FakeRuntime;
  replay?: FirstPaint | null;
  /** ScrollbackPort.replayBeforeLaunch's answer. */
  before?: FirstPaint | null;
  stopping?: boolean;
  e2e?: boolean;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  resolveCommand?: (command: string) => string | undefined;
  /** Default true: the first reconcile (`adopted([])`) has run, so starts can spawn. */
  reconciled?: boolean;
}

const tempDirs: string[] = [];
const domains: Domain[] = [];

/** For afterEach: disposes every harness's domain and removes the temp dirs harnesses made. */
export function disposeHarnesses(): void {
  for (const d of domains.splice(0)) d.dispose();
  // dispose() doesn't wait for an async atomic write still in flight; rm retries past it.
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** A domain over fakes for every port, in a fresh temp userData (posix paths on CI). */
export function harness(opts: HarnessOptions = {}) {
  let userData = opts.userData;
  if (!userData) {
    userData = mkdtempSync(join(tmpdir(), 'conduit-w4-'));
    tempDirs.push(userData);
  }
  const home = join(userData, 'home');
  mkdirSync(home, { recursive: true });
  for (const [name, text] of Object.entries(opts.files ?? {}))
    writeFileSync(join(userData, name), text);
  const runtime = opts.runtime ?? new FakeRuntime();
  const calls = runtime.calls;
  const events: RecordedEvent[] = [];
  const shown: { sessionId: string; data: string }[] = [];
  const recorded: { sessionId: string; data: string }[] = [];
  /** W6's runtime.lastSizeOf, which C1 does not carry. */
  const lastSizes = new Map<string, TermGeometry>();
  const written: { sessionId: string; data: string; generation?: number }[] = [];
  const drafts: { sessionId: string; data: string }[] = [];
  const submitted: { sessionId: string; text: string }[] = [];
  const state = {
    stopping: opts.stopping ?? false,
    busy: false,
    replay: opts.replay ?? null,
    before: opts.before ?? null,
  };
  const logs: string[] = [];
  const log = (level: string) => (scope: string, msg: string) =>
    logs.push(`${level} ${scope} ${msg}`);
  const deps: DomainDeps = {
    userData,
    homeDir: home,
    platform: opts.platform ?? process.platform,
    instance: 'inst',
    e2e: opts.e2e ?? false,
    env: opts.env ?? {},
    runtime,
    launch: {
      whenLaunchReady: async () => {
        calls.push('whenLaunchReady');
      },
      prepareLaunch: async (_id, _def, spec, ids) => {
        calls.push(`prepareLaunch:${ids.generation}`);
        return { ...spec, env: { ...spec.env, CONDUIT_SESSION_TOKEN: 't' } };
      },
      onSessionDeleted: async (id) => {
        calls.push(`onSessionDeleted:${id}`);
      },
    },
    drafts: { noteHostInput: (sessionId, data) => drafts.push({ sessionId, data }) },
    scrollback: {
      replayForColdStart: (id) => {
        calls.push(`replay:${id}`);
        return state.replay;
      },
      replayBeforeLaunch: (id) => {
        calls.push(`before:${id}`);
        return state.before ?? null;
      },
      show: (sessionId, data) => {
        calls.push('show');
        shown.push({ sessionId, data });
      },
      record: (sessionId, data) => {
        calls.push('record');
        recorded.push({ sessionId, data });
      },
      forget: (id) => calls.push(`forget:${id}`),
    },
    attention: {
      statusOf: () => ({
        busy: state.busy,
        needsAttention: false,
        completedRun: false,
        attentionReason: null,
        completions: 0,
      }),
    },
    typing: {
      submit: async (sessionId, text): Promise<SubmitOutcome> => {
        submitted.push({ sessionId, text });
        return 'submitted';
      },
      write: (sessionId, data, o) => {
        written.push({
          sessionId,
          data,
          ...(o?.generation === undefined ? {} : { generation: o.generation }),
        });
        return true;
      },
      forget: () => {},
    },
    emit: <E extends ServerEvent>(type: E, data: ServerEvents[E]) => {
      events.push({ type, data });
    },
    stopping: () => state.stopping,
    installState: () => 'not-installed',
    detectShells: () => [SHELL],
    detectClis: () => [CLAUDE],
    resolveCommand: opts.resolveCommand ?? ((c) => c),
    lastSizeOf: (id) => lastSizes.get(id),
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
  };
  const domain: Domain = createDomain(deps);
  domains.push(domain);
  if (opts.reconciled ?? true) domain.adopted([]);
  /** One C2 request; a refusal rejects with the RpcFault. */
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const answer = domain.handle({ id: 1, method, params });
    if (!answer) throw new Error(`not a domain method: ${method}`);
    const a = await answer;
    if ('error' in a) throw a.error;
    if ('reply' in a) return undefined;
    return a.result;
  };
  const create = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const r = (await call('sessions.create', { agentId: 'sh', home, ...extra })) as {
      sessionId: string;
    };
    return r.sessionId;
  };
  const types = () => events.map((e) => e.type);
  return {
    userData,
    home,
    runtime,
    calls,
    events,
    types,
    shown,
    recorded,
    lastSizes,
    written,
    drafts,
    submitted,
    state,
    logs,
    deps,
    domain,
    call,
    create,
  };
}

export const isFault = (e: unknown, kind: string): boolean =>
  e instanceof RpcFault && e.kind === kind;
