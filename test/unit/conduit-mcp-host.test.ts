import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShimEndpoint } from '../../server/mcp/endpoint';
import { createSessionScreens, type SessionScreens } from '../../server/runtime/session-screens';
import { createTokenStore } from '../../server/runtime/testing/token-store';
import { AgentRegistry } from '../../src/agent-registry';
import type { StuckScreen } from '../../src/cli-stuck-screens';
import { MCP_ADAPTERS } from '../../src/conduit-mcp/adapters';
import type { McpFileRequest, McpOpenRequest, PathKind } from '../../src/conduit-mcp/control-tools';
import {
  type ConduitMcpHost,
  type ConduitMcpHostDeps,
  createConduitMcpHost,
  ENDPOINT_READY_WAIT_MS,
  type McpRendererMessage,
  QUEUE_STABLE_MS,
} from '../../src/conduit-mcp/host';
import {
  ECHO_POLL_MS,
  LATE_ECHO_POLL_MS,
  LATE_ECHO_WAIT_MS,
  NOTICE_SPACING_MS,
} from '../../src/conduit-mcp/notice-gate';
import { composeNotice } from '../../src/conduit-mcp/notice-text';
import { screenVerdict } from '../../src/conduit-mcp/screen-verdict';
import type { StoreIo } from '../../src/conduit-mcp/store';
import {
  type CliPolicyLayers,
  DEFAULT_TOOL_POLICY,
  type GlobalPolicy,
  type PolicyLayer,
  TOOL_NAMES,
  type ToolName,
  withPolicyPatch,
} from '../../src/conduit-mcp/tool-policy';
import { toolError } from '../../src/conduit-mcp/types';
import type { McpHostDeps, TokenStorePort } from '../../src/contracts/server-ports';
import type { ServerEvents } from '../../src/contracts/server-protocol';
import type {
  LaunchIds,
  RuntimeEvent,
  RuntimeTerminal,
} from '../../src/contracts/terminal-runtime';
import { compileLimitRules, DEFAULT_LIMIT_RULES } from '../../src/limit-rules';
import type { HostToWebview } from '../../src/protocol';
import { createPtyWriter } from '../../src/pty-writer';
import { COMMAND_AGENT_ID, commandDef } from '../../src/session-command';
import type { AgentDefinition, Session, SpawnSpec } from '../../src/types';
import { testEndpoint } from '../helpers/test-endpoint';

const FAKE: AgentDefinition = {
  id: 'e2e-fake-mcp',
  label: 'Fake MCP',
  command: '/usr/bin/node',
  args: ['fake.mjs'],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
};
const SHELL: AgentDefinition = { ...FAKE, id: 'pwsh', command: 'pwsh' };
/** Measured (runtime QA 2026-10-27, F1): a relaunched cmd.exe shell's bytes around Claude's initialize. */
const CLAUDE_BEFORE_INIT: {
  cols: number;
  rows: number;
  beforeInitialize: string;
  afterInitialize: string;
} = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'conduit-mcp', 'claude-box-before-initialize.json'),
    'utf8',
  ),
);
const CODEX: AgentDefinition = { ...FAKE, id: 'codex', command: '/usr/bin/codex' };
const CURSOR: AgentDefinition = { ...FAKE, id: 'cursor', command: '/usr/bin/agent' };
/** The e2e fake that queues mid-turn input (adapters.ts `fake-queue`, CON-172). */
const FAKE_QUEUE: AgentDefinition = { ...FAKE, id: 'e2e-fake-mcp-queue' };
const CLAUDE: AgentDefinition = { ...FAKE, id: 'claude', command: '/usr/bin/claude' };
const DEFS = [FAKE, SHELL, CODEX, CURSOR, CLAUDE, FAKE_QUEUE];
const defOfSession = (s: Session | undefined): AgentDefinition | undefined =>
  s?.agentId === COMMAND_AGENT_ID
    ? s.command && commandDef(s.command)
    : DEFS.find((d) => d.id === s?.agentId);
const spec = (command = '/usr/bin/node'): SpawnSpec => ({
  command,
  args: ['fake.mjs'],
  cwd: '/w',
  env: { A: '1' },
});

/** The harness's detection grace; the host default (DETECT_GRACE_MS) is main's. */
const GRACE = 1_000;

const noLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}
function recordingLog() {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry['level']) => (scope: string, msg: string, data?: Record<string, unknown>) => {
      entries.push({ level, scope, msg, data });
    };
  return {
    entries,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    of: (msg: string) => entries.filter((e) => e.msg === msg),
  };
}

interface Harness {
  host: ConduitMcpHost;
  dir: string;
  ep: string;
  clock: { t: number };
  sessions: Map<string, Session>;
  inputs: Array<[string, string]>;
  echo: Set<string>;
  busy: Set<string>;
  lastOut: Map<string, number>;
  broadcasts: HostToWebview[];
  calls: string[];
  alive: Set<string>;
  gens: Map<string, number>;
  writer: ReturnType<typeof createPtyWriter>;
  /** Gap releases, when the harness holds submit gaps. */
  gaps: Array<() => void>;
  /** Late-echo poll sleeps, when the harness holds them so cancel can be observed alive. */
  lateEchoSleeps: Array<{ ms: number; release(): void }>;
  releaseLateEcho(): Promise<void>;
  failEnter: Set<string>;
  submitEnterCalls: number;
  /** Every control open/file request the host handed to main. */
  opens: McpOpenRequest[];
  files: McpFileRequest[];
  screens: SessionScreens;
  /** Every host → owner-window message, in order. */
  toOwner: Array<{ to: string; msg: HostToWebview }>;
  toWindow: Array<{ windowId: number; msg: HostToWebview }>;
  flashed: string[];
  /** Owner window per session; absent ⇒ window 1. */
  owners: Map<string, number | null>;
  /** Ready windows, and what each shows; a window absent from `shown` shows every session. */
  presence: { ready: Set<number>; shown: Map<number, Set<string>> };
  /** With opts.manualTimers: runs every timer due within `ms` from now. */
  advance(ms: number): void;
  addRoots: Array<{ id: string; path: string }>;
  activations: Array<{ id: string; raise: boolean }>;
  closes: string[];
  tokens: TokenStorePort;
  prepareLaunch(sessionId: string, def: AgentDefinition, spec: SpawnSpec): Promise<SpawnSpec>;
  spawn(sessionId: string, cols?: number, rows?: number): void;
  respawn(sessionId: string, cols?: number, rows?: number): void;
  resize(sessionId: string, cols: number, rows: number): void;
  exit(sessionId: string, code?: number | null): void;
  output(sessionId: string, data: string): void;
  /** Ends the session turn the way the server attention does: busy clears, the run counts. */
  finishTurn(sessionId: string): void;
  /** Flips the session needs-you reason, as the server attention does. */
  setNeedsYou(sessionId: string, on: boolean): void;
  /** Host timers armed and not yet fired or cleared. */
  readonly pendingTimers: number;
  /** Every stuck-screen verdict the host handed to attention, in order. */
  stuckCalls: Array<[string, StuckScreen | null]>;
  /** Every session whose screen the host read, in order. */
  screenReads: string[];
}

const dirs: string[] = [];
const hosts: ConduitMcpHost[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: `S ${id}`,
    agentId: 'e2e-fake-mcp',
    home: '/w',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...extra,
  };
}

function harness(
  opts: {
    dir?: string;
    registry?: AgentRegistry;
    messagingOn?: () => boolean;
    storeIo?: StoreIo;
    listen?: boolean;
    platform?: ConduitMcpHostDeps['platform'];
    holdGaps?: boolean;
    /**
     * Hold LATE_ECHO_POLL_MS sleeps only: an instant poll would expire the watcher before cancel,
     * and exit/delete/stop would then close the recheck without the cancel path running.
     */
    holdLateEcho?: boolean;
    /** Typed text shows on screen only at the host's next wait, as Codex renders it (measured). */
    lagEcho?: boolean;
    /** The fake prompt answers an Enter with a fresh empty prompt line. */
    echoSubmit?: boolean;
    /** Runs inside the host's wait between echo polls, i.e. while the Enter is still pending. */
    duringWait?: (host: ConduitMcpHost) => void;
    /** Runs inside the queue-mode stability wait (QUEUE_STABLE_MS), between the two screen reads. */
    onStableWait?: (host: ConduitMcpHost) => void;
    tickMs?: number;
    log?: ConduitMcpHostDeps['log'];
    createEndpoint?: ConduitMcpHostDeps['createEndpoint'];
    kinds?: Record<string, PathKind>;
    /** Records every line the host sends into `calls`, so ordering against setMcp is visible. */
    recordSends?: boolean;
    installState?: McpHostDeps['domain']['installState'];
    toolPolicy?: () => { global: GlobalPolicy; byCli: CliPolicyLayers };
    kindOf?: (abs: string) => Promise<PathKind>;
    bracketedPaste?: () => boolean;
    /** Timers fire only through advance(); otherwise asks and UI waits never expire. */
    manualTimers?: boolean;
  } = {},
): Harness {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-host-'));
  if (!opts.dir) dirs.push(dir);
  const ep = testEndpoint();
  const clock = { t: 1_000_000 };
  const sessions = new Map<string, Session>();
  const inputs: Array<[string, string]> = [];
  const echo = new Set<string>();
  const busy = new Set<string>();
  const lastOut = new Map<string, number>();
  const broadcasts: HostToWebview[] = [];
  const calls: string[] = [];
  const alive = new Set<string>();
  const gens = new Map<string, number>();
  const launchIds = new Map<string, string>();
  const terminals = new Map<string, RuntimeTerminal>();
  const runtimeListeners = new Set<(event: RuntimeEvent) => void>();
  let launchN = 0;
  let tokenN = 0;
  const allocateLaunch = (id: string): LaunchIds => {
    const generation = (gens.get(id) ?? 0) + 1;
    const launchId = (++launchN).toString(16).padStart(32, '0');
    gens.set(id, generation);
    launchIds.set(id, launchId);
    return { generation, launchId };
  };
  const emitRuntime = (event: RuntimeEvent) => {
    for (const listener of runtimeListeners) listener(event);
  };
  const gaps: Array<() => void> = [];
  const lateEchoSleeps: Array<{ ms: number; release(): void }> = [];
  const failEnter = new Set<string>();
  const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  const releaseLateEcho = async () => {
    await flushMicrotasks();
    const g = lateEchoSleeps.shift();
    if (!g) throw new Error('no pending late-echo sleep');
    g.release();
    await flushMicrotasks();
  };
  const opens: McpOpenRequest[] = [];
  const files: McpFileRequest[] = [];
  const lagged: Array<[string, string]> = [];
  const screens = createSessionScreens();
  const tokens = createTokenStore({ randomToken: () => `tok${++tokenN}` });
  const timers = new Map<number, { fn: () => void; at: number }>();
  let timerN = 0;
  const advance = (ms: number) => {
    clock.t += ms;
    for (const [id, t] of [...timers])
      if (t.at <= clock.t) {
        timers.delete(id);
        t.fn();
      }
  };
  const addRoots: Harness['addRoots'] = [];
  const activations: Harness['activations'] = [];
  const toOwner: Harness['toOwner'] = [];
  const toWindow: Harness['toWindow'] = [];
  const flashed: string[] = [];
  const closes: string[] = [];
  const owners = new Map<string, number | null>();
  const presence: Harness['presence'] = { ready: new Set([1, 2]), shown: new Map() };
  let askN = 0;
  let host: ConduitMcpHost;
  const output: Harness['output'] = (id, data) => {
    screens.feed(id, data);
    emitRuntime({ type: 'data', sessionId: id, generation: gens.get(id) ?? 0, data });
  };
  const spawn: Harness['spawn'] = (id, cols = 40, rows = 24) => {
    const generation = gens.get(id) ?? 0;
    alive.add(id);
    terminals.set(id, {
      sessionId: id,
      generation,
      launchId: launchIds.get(id) ?? '0'.repeat(32),
      state: 'live',
      size: { cols, rows },
      target: { hcSession: 'hc-test', terminal: id },
    });
    emitRuntime({ type: 'spawned', sessionId: id, generation, size: { cols, rows } });
  };
  const respawn: Harness['respawn'] = (id, cols = 40, rows = 24) => {
    const generation = (gens.get(id) ?? 0) + 1;
    gens.set(id, generation);
    alive.add(id);
    terminals.set(id, {
      sessionId: id,
      generation,
      launchId: launchIds.get(id) ?? '0'.repeat(32),
      state: 'live',
      size: { cols, rows },
      target: { hcSession: 'hc-test', terminal: id },
    });
    emitRuntime({ type: 'spawned', sessionId: id, generation, size: { cols, rows } });
  };
  const resize: Harness['resize'] = (id, cols, rows) => {
    const terminal = terminals.get(id);
    if (terminal) terminal.size = { cols, rows };
    screens.resize(id, cols, rows);
    emitRuntime({ type: 'size', sessionId: id, size: { cols, rows } });
  };
  const exit: Harness['exit'] = (id, code = 0) => {
    const generation = gens.get(id) ?? 0;
    alive.delete(id);
    terminals.delete(id);
    emitRuntime({ type: 'exit', sessionId: id, generation, code, reason: 'exited' });
    // The server's attention records every runtime exit as a change.
    notifyAttention();
  };
  let submitEnterCalls = 0;
  const writer = createPtyWriter({
    generation: (id) => gens.get(id),
    input: (id, data) => {
      if (data === '\r' && failEnter.has(id)) return false;
      inputs.push([id, data]);
      // The PTY echoes typed text back, which the host's screen model then shows.
      if (!echo.has(id)) return true;
      if (data === '\r') {
        if (opts.echoSubmit) output(id, '\r\nfake❯ ');
      } else if (opts.lagEcho) lagged.push([id, data]);
      else output(id, data);
      return true;
    },
    sleep: () => Promise.resolve(),
    outputQuiet: () => (opts.holdGaps ? new Promise<void>((r) => gaps.push(r)) : Promise.resolve()),
  });
  const sessionStore: McpHostDeps['sessions'] = {
    get: (id: string) => sessions.get(id),
    list: () => [...sessions.values()],
    setMcp: (id: string, patch: Partial<Session>) => {
      const s = sessions.get(id);
      if (!s) return false;
      const counters = fs.existsSync(path.join(dir, 'handles.json'))
        ? fs.readFileSync(path.join(dir, 'handles.json'), 'utf8')
        : '';
      calls.push(`setMcp ${JSON.stringify(patch)} handles=${counters.replace(/\s/g, '')}`);
      Object.assign(s, patch);
      return true;
    },
    setMcpToolPolicy: (
      id: string,
      tool: ToolName,
      patch: Parameters<typeof withPolicyPatch>[2],
    ) => {
      const s = sessions.get(id);
      if (!s) return false;
      const next = withPolicyPatch(s.mcpToolPolicy, tool, patch);
      if (next) s.mcpToolPolicy = next;
      else delete s.mcpToolPolicy;
      return true;
    },
    touch: (id: string, at: number) => {
      const s = sessions.get(id);
      if (!s) return false;
      s.lastActiveAt = at;
      return true;
    },
    setStatus: (id: string, status: Session['status']) => {
      const s = sessions.get(id);
      if (!s) return false;
      s.status = status;
      return true;
    },
    onChange: () => ({ dispose: () => [] }),
    allocateLaunch,
  };
  const registry = opts.registry ?? new AgentRegistry(DEFS);
  const domain: McpHostDeps['domain'] = {
    bracketedPaste: opts.bracketedPaste ?? (() => false),
    limitRules: () => compileLimitRules(DEFAULT_LIMIT_RULES),
    homeOf: (id: string) => sessions.get(id)?.home,
    resolvePath: (h: string, rel: string) => (rel.startsWith('/') ? rel : `${h}/${rel}`),
    kindOf: opts.kindOf ?? (async (abs: string) => opts.kinds?.[abs] ?? 'missing'),
    agentIds: () => registry.list().map((d) => d.id),
    agentCatalog: () => registry.list().map((def) => ({ def, source: 'profile' as const })),
    resolveCommand: (c: string) => `/usr/bin/${c}`,
    openSession: async (req: McpOpenRequest) => {
      const id = `n${opens.length + 1}`;
      opens.push(req);
      sessions.set(
        id,
        session(id, {
          agentId: req.launch.kind === 'agent' ? req.launch.agentId : COMMAND_AGENT_ID,
          home: req.home,
          ...(req.launch.kind === 'command' ? { command: req.launch.command } : {}),
          openedBy: req.openedBy,
        }),
      );
      return { ok: true as const, sessionId: id, label: `S ${id}` };
    },
    closeSession: async (id: string) => {
      closes.push(id);
      sessions.delete(id);
      return { ok: true as const };
    },
    foldersOf: (id: string) => {
      const s = sessions.get(id);
      return s ? { home: s.home, roots: [...s.roots] } : undefined;
    },
    addRoot: async (id: string, p: string) => {
      addRoots.push({ id, path: p });
      sessions.get(id)?.roots.push(p);
      return { ok: true as const };
    },
    git: async () => ({ ok: false as const, stdout: '', stderr: 'not a git repository' }),
    defOf: (id: string) => defOfSession(sessions.get(id)),
    agentDef: (id: string) => registry.get(id),
    projectName: () => null,
    installState: opts.installState ?? (() => 'not-installed' as const),
    messagingOn: opts.messagingOn ?? (() => true),
    toolPolicy: opts.toolPolicy ?? (() => ({ global: DEFAULT_TOOL_POLICY, byCli: {} })),
  };
  const attentionListeners = new Set<Parameters<McpHostDeps['attention']['onEdge']>[0]>();
  const completions = new Map<string, number>();
  const needing = new Set<string>();
  const stuckCalls: Array<[string, StuckScreen | null]> = [];
  const stuck = new Map<string, StuckScreen>();
  const screenReads: string[] = [];
  const changeListeners = new Set<() => void>();
  const notifyAttention = () => {
    for (const l of changeListeners) l();
  };
  const attention: McpHostDeps['attention'] = {
    statusOf: (id) => {
      const s = stuck.get(id);
      return {
        busy: busy.has(id),
        needsAttention: false,
        completedRun: false,
        attentionReason: s ? 'stuck' : needing.has(id) ? 'blocked' : null,
        ...(s ? { stuckReason: s.reason } : {}),
        completions: completions.get(id) ?? 0,
      };
    },
    setResumeIssue: () => undefined,
    setStuck: (id, next) => {
      stuckCalls.push([id, next]);
      if (next) stuck.set(id, next);
      else stuck.delete(id);
      notifyAttention();
    },
    lastOutputAt: (id) => lastOut.get(id),
    setVisible: () => false,
    dropWindow: () => undefined,
    recordInput: (id, at) => lastOut.set(id, at),
    clearAll: () => undefined,
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onEdge: (listener) => {
      attentionListeners.add(listener);
      return () => attentionListeners.delete(listener);
    },
  };
  const screenPort: McpHostDeps['screens'] = {
    ensure: (id) => {
      const size = terminals.get(id)?.size ?? { cols: 40, rows: 24 };
      if (!screens.has(id)) screens.start(id, size.cols, size.rows);
    },
    keepTail: (id) => {
      const size = terminals.get(id)?.size ?? { cols: 40, rows: 24 };
      screens.keepTail(id, size.cols, size.rows);
    },
    release: (id) => screens.dispose(id),
  };
  const emit: McpHostDeps['emit'] = (type, data) => {
    if (type === 'ui.post') {
      const post = data as ServerEvents['ui.post'];
      if (post.route.kind === 'owner')
        toOwner.push({ to: post.route.sessionId, msg: post.message });
      else if (post.route.kind === 'window')
        toWindow.push({ windowId: post.route.windowId, msg: post.message });
      else broadcasts.push(post.message);
      if (post.message.type === 'activateSession')
        activations.push({ id: post.message.sessionId, raise: post.raise === true });
      if (post.message.type === 'openFileInEditor' && post.message.source === 'mcp')
        files.push({
          callerSessionId: post.message.sessionId,
          path: post.message.path,
          line: post.message.line,
          column: post.message.column,
          focus: post.message.focus,
        });
    } else if (type === 'attention.flash') {
      flashed.push((data as ServerEvents['attention.flash']).sessionId);
    }
  };
  host = createConduitMcpHost({
    dir,
    hookClientPath: null,
    gitBashPath: () => undefined,
    homeDir: dir,
    endpointPath: ep,
    execPath: '/opt/conduit/conduit',
    shimPath: '/opt/conduit/resources/conduit-mcp/conduit-mcp-shim.cjs',
    platform: opts.platform ?? 'linux',
    e2e: true,
    sessions: sessionStore,
    domain,
    attention,
    typing: {
      submit: writer.submit,
      sequence: writer.sequence,
      submitEnter: (sessionId, opts) => {
        submitEnterCalls += 1;
        return writer.submitEnter(sessionId, opts);
      },
      write: (id, data) => {
        inputs.push([id, data]);
        return alive.has(id);
      },
      forget: writer.forget,
    },
    screens: screenPort,
    tokens,
    runtime: {
      get: (id) => terminals.get(id),
      screen: async (id) => {
        screenReads.push(id);
        return (await screens.snapshot(id)) ?? null;
      },
      on: (listener) => {
        runtimeListeners.add(listener);
        return () => runtimeListeners.delete(listener);
      },
    },
    emit,
    ownerWindowOf: (id) => (owners.has(id) ? (owners.get(id) ?? null) : 1),
    windowReady: (w) => presence.ready.has(w),
    onScreen: (w, id) => presence.shown.get(w)?.has(id) ?? true,
    newAskId: () => `ask-${++askN}`,
    setTimer: (fn, ms) => {
      if (!opts.manualTimers) return undefined;
      timers.set(++timerN, { fn, at: clock.t + ms });
      return timerN;
    },
    clearTimer: (h) => timers.delete(h as number),
    detectGraceMs: GRACE,
    log: opts.log ?? noLog,
    now: () => clock.t,
    sleep: async (ms) => {
      const finish = () => {
        clock.t += ms;
        opts.duringWait?.(host);
        if (ms === QUEUE_STABLE_MS) opts.onStableWait?.(host);
        for (const [id, data] of lagged.splice(0)) output(id, data);
      };
      if (opts.holdLateEcho && ms === LATE_ECHO_POLL_MS) {
        await new Promise<void>((resolve) => {
          lateEchoSleeps.push({
            ms,
            release: () => {
              finish();
              resolve();
            },
          });
        });
        return;
      }
      finish();
    },
    storeIo: opts.storeIo,
    listen: opts.listen ?? true,
    tickMs: opts.tickMs ?? 0,
    createEndpoint:
      opts.createEndpoint ??
      (opts.recordSends
        ? (o) =>
            createShimEndpoint({
              ...o,
              tokens,
              onConnection: (conn) =>
                o.onConnection({
                  id: conn.id,
                  token: conn.token,
                  send: (line) => {
                    calls.push(`send ${line}`);
                    conn.send(line);
                  },
                  onLine: (cb) => conn.onLine(cb),
                  onClose: (cb) => conn.onClose(cb),
                  close: () => conn.close(),
                }),
            })
        : (o) => createShimEndpoint({ ...o, tokens })),
  });
  hosts.push(host);
  return {
    host,
    dir,
    ep,
    clock,
    stuckCalls,
    screenReads,
    sessions,
    inputs,
    echo,
    busy,
    lastOut,
    broadcasts,
    calls,
    alive,
    gens,
    writer,
    gaps,
    lateEchoSleeps,
    releaseLateEcho,
    failEnter,
    get submitEnterCalls() {
      return submitEnterCalls;
    },
    opens,
    files,
    screens,
    toOwner,
    toWindow,
    flashed,
    owners,
    presence,
    advance,
    addRoots,
    activations,
    closes,
    tokens,
    prepareLaunch: (id, def, sp) => host.prepareLaunch(id, def, sp, allocateLaunch(id)),
    spawn,
    respawn,
    resize,
    exit,
    output,
    finishTurn(id) {
      busy.delete(id);
      completions.set(id, (completions.get(id) ?? 0) + 1);
      notifyAttention();
    },
    setNeedsYou(id, on) {
      if (on) needing.add(id);
      else needing.delete(id);
      notifyAttention();
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

/** A minimal JSON-RPC client over the endpoint, as the shim + CLI would be. */
async function client(ep: string, token: string | null, clientName?: string) {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(ep, () => resolve(s));
    s.on('error', reject);
  });
  sockets.push(sock);
  sock.setEncoding('utf8');
  let buf = '';
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  const notifications: string[] = [];
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      if (msg.id === undefined && typeof msg.method === 'string') notifications.push(msg.method);
      else waiting.get(msg.id as number)?.(msg);
      i = buf.indexOf('\n');
    }
  });
  sock.write(`${JSON.stringify({ conduit: 1, token })}\n`);
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    ...(clientName === undefined ? {} : { clientInfo: { name: clientName, version: '1' } }),
  });
  const call = async (name: string, args: unknown = {}) => {
    const r = (await request('tools/call', { name, arguments: args })) as {
      result: { content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean };
    };
    return {
      isError: r.result.isError === true,
      // A hinted error's text is prose; its structured body carries the code.
      body: r.result.structuredContent ?? JSON.parse(r.result.content[0].text),
      content: r.result.content,
    };
  };
  const listed = async () => {
    const r = (await request('tools/list')) as { result: { tools: Array<{ name: string }> } };
    return r.result.tools.map((t) => t.name);
  };
  return { request, call, sock, notifications, listed };
}

/** A client that sends only the hello: the test drives every request, initialize included. */
async function helloOnly(ep: string, token: string | null) {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(ep, () => resolve(s));
    s.on('error', reject);
  });
  sockets.push(sock);
  sock.setEncoding('utf8');
  const closed = new Promise<void>((r) => sock.on('close', () => r()));
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  const notifications: string[] = [];
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      if (msg.id === undefined && typeof msg.method === 'string') notifications.push(msg.method);
      else waiting.get(msg.id as number)?.(msg);
      i = buf.indexOf('\n');
    }
  });
  sock.write(`${JSON.stringify({ conduit: 1, token })}\n`);
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(id, resolve);
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { request, closed, notifications };
}

/** Launch a fake session through prepareLaunch + the runtime's spawned event. */
async function launch(h: Harness, id: string, def = FAKE, sp = spec()) {
  if (!h.sessions.has(id)) h.sessions.set(id, session(id, { agentId: def.id }));
  const out = await h.prepareLaunch(id, def, sp);
  h.spawn(id, 40, 24);
  return { spec: out, token: out.env?.CONDUIT_SESSION_TOKEN ?? null };
}

/** Bring a session to an open gate: settled, quiet, idle prompt on screen, connected. */
async function ready(h: Harness, id: string) {
  const { token } = await launch(h, id);
  const c = await client(h.ep, token);
  h.output(id, 'fake❯ ');
  h.echo.add(id);
  return c;
}

const settle = (h: Harness) => {
  h.clock.t += 5_000;
};

const writesTo = (h: Harness, id: string) => h.inputs.filter(([s]) => s === id).map(([, d]) => d);

async function waitLateEchoHeld(h: Harness, n = 1) {
  await expect.poll(() => h.lateEchoSleeps.length).toBe(n);
}

function lateEchoOutcomes(rec: ReturnType<typeof recordingLog>) {
  return {
    submitted: rec.of('notice late echo submitted'),
    abandoned: rec.of('notice late echo abandoned'),
    expired: rec.of('notice late echo expired'),
  };
}

async function lastState(h: Harness) {
  await expect.poll(() => h.broadcasts.length, { timeout: 2_000 }).toBeGreaterThan(0);
  return h.host.uiState();
}

describe('createConduitMcpHost — launch', () => {
  it('leaves Cursor launch unchanged and reports cursor-not-connected without the user entry', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    const original = spec('/usr/bin/agent');
    expect(await h.prepareLaunch('c1', CURSOR, original)).toBe(original);
    expect(h.host.uiState().sessions.c1?.unavailable).toBe('cursor-not-connected');
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'missing token placeholder',
      JSON.stringify({
        mcpServers: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's literal ${env:…} placeholder, not a template
          conduit: { env: { CONDUIT_MCP_ENDPOINT: '${env:CONDUIT_MCP_ENDPOINT}' } },
        },
      }),
    ],
    [
      'missing endpoint placeholder',
      JSON.stringify({
        mcpServers: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's literal ${env:…} placeholder, not a template
          conduit: { env: { CONDUIT_SESSION_TOKEN: '${env:CONDUIT_SESSION_TOKEN}' } },
        },
      }),
    ],
  ])('leaves Cursor launch unchanged for %s', async (_label, contents) => {
    const h = harness();
    const cursorDir = path.join(h.dir, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, 'mcp.json'), contents);
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    const original = spec('/usr/bin/agent');
    expect(await h.prepareLaunch('c1', CURSOR, original)).toBe(original);
    expect(h.host.uiState().sessions.c1?.unavailable).toBe('cursor-not-connected');
  });

  it('wires Cursor with no args when a stale user entry has both env placeholders', async () => {
    const h = harness();
    const cursorDir = path.join(h.dir, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          conduit: {
            command: '/old/conduit',
            args: ['old-shim'],
            env: {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's literal ${env:…} placeholder, not a template
              CONDUIT_SESSION_TOKEN: '${env:CONDUIT_SESSION_TOKEN}',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's literal ${env:…} placeholder, not a template
              CONDUIT_MCP_ENDPOINT: '${env:CONDUIT_MCP_ENDPOINT}',
            },
          },
        },
      }),
    );
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    const original = spec('/usr/bin/agent');
    const out = await h.prepareLaunch('c1', CURSOR, original);
    expect(out.args).toEqual(original.args);
    expect(out.env).toMatchObject({ CONDUIT_SESSION_TOKEN: 'tok1', CONDUIT_MCP_ENDPOINT: h.ep });
    expect(h.host.uiState().sessions.c1?.unavailable).toBeNull();
  });

  it('prepareLaunch for fake adds --mcp-config and a token; config file written without the token; env has no ELECTRON_RUN_AS_NODE', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    const out = await h.prepareLaunch('s1', FAKE, spec());
    const cfgPath = path.join(h.dir, 'launch', 's1.json');
    expect(out.args?.slice(0, 3)).toEqual(['fake.mjs', '--mcp-config', cfgPath]);
    expect(out.args?.[3]).toBe('--allowedTools');
    expect(out.args).toHaveLength(5);
    expect(out.env).toEqual({ A: '1', CONDUIT_SESSION_TOKEN: 'tok1', CONDUIT_MCP_ENDPOINT: h.ep });
    expect(out.env && 'ELECTRON_RUN_AS_NODE' in out.env).toBe(false);
    const cfg = fs.readFileSync(cfgPath, 'utf8');
    expect(cfg).not.toContain('tok1');
    expect(JSON.parse(cfg).mcpServers.conduit.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(h.sessions.get('s1')?.mcpHandle).toBe('fake-1');
  });

  it('async prepareLaunch reserves the token row with the caller allocated launch ids', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    const ids: LaunchIds = { generation: 7, launchId: 'f'.repeat(32) };
    const pending = h.host.prepareLaunch('s1', FAKE, spec(), ids);
    expect(pending).toBeInstanceOf(Promise);
    const wired = await pending;
    expect(wired.env?.CONDUIT_SESSION_TOKEN).toBe('tok1');
    expect(h.tokens.rows()).toMatchObject({
      state: 'loaded',
      rows: [
        {
          sessionId: 's1',
          generation: 7,
          launchId: ids.launchId,
          state: 'reserved',
          hcAddress: null,
        },
      ],
    });
  });

  it('the token value reaches only the PTY env: never args or a config file', async () => {
    const h = harness();
    await h.host.start();
    for (const [id, def, cmd] of [
      ['s1', FAKE, '/usr/bin/node'],
      ['s2', CODEX, '/usr/bin/codex'],
    ] as const) {
      h.sessions.set(id, session(id, { agentId: def.id }));
      const out = await h.prepareLaunch(id, def, spec(cmd));
      const token = out.env?.CONDUIT_SESSION_TOKEN;
      expect(token).toMatch(/^tok\d+$/);
      expect(out.args.join(' ')).not.toContain(token);
      const cfg = path.join(h.dir, 'launch', `${id}.json`);
      if (fs.existsSync(cfg)) expect(fs.readFileSync(cfg, 'utf8')).not.toContain(token);
    }
    expect(fs.existsSync(path.join(h.dir, 'launch', 's1.json'))).toBe(true);
  });

  it('AC1 a plain shell gets token + endpoint and no handle', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1', { agentId: 'pwsh' }));
    const sp = spec('/usr/bin/pwsh');
    const out = await h.prepareLaunch('s1', SHELL, sp);
    expect(out.env).toEqual({ A: '1', CONDUIT_SESSION_TOKEN: 'tok1', CONDUIT_MCP_ENDPOINT: h.ep });
    expect(out.args).toEqual(sp.args);
    expect(out.command).toBe(sp.command);
    expect(h.sessions.get('s1')?.mcpHandle).toBeUndefined();
    expect(fs.existsSync(path.join(h.dir, 'launch', 's1.json'))).toBe(false);
    expect(h.host.uiState().sessions).toEqual({});
  });

  it('AC1 messaging off or endpoint down: a shell gets nothing, uiState shows nothing', async () => {
    let on = false;
    const h = harness({ messagingOn: () => on });
    h.sessions.set('s1', session('s1', { agentId: 'pwsh' }));
    const sp = spec('/usr/bin/pwsh');
    on = true;
    expect(await h.prepareLaunch('s1', SHELL, sp)).toBe(sp);
    await h.host.start();
    on = false;
    expect(await h.prepareLaunch('s1', SHELL, sp)).toBe(sp);
    expect(h.sessions.get('s1')?.mcpHandle).toBeUndefined();
    expect(h.host.uiState().sessions).toEqual({});
  });

  it('messaging off → unchanged + unavailable messaging-off', async () => {
    const h = harness({ messagingOn: () => false });
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    const sp = spec();
    expect(await h.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1).toMatchObject({
      handle: 'fake-1',
      unavailable: 'messaging-off',
      gate: null,
    });
  });

  it('guard trip → unchanged + unavailable cmd-metachar', async () => {
    const h = harness({ platform: 'win32' });
    await h.host.start();
    const id = 'a&b';
    h.sessions.set(id, session(id));
    const sp = spec('C:\\npm\\fake.cmd');
    expect(await h.prepareLaunch(id, FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions[id]?.unavailable).toBe('cmd-metachar');
  });

  it('handle allocation writes handles.json before setMcp', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    await h.prepareLaunch('s1', FAKE, spec());
    expect(h.calls).toEqual(['setMcp {"mcpHandle":"fake-1"} handles={"fake":1}']);
  });

  it('a kept handle is not re-allocated; a duplicate holder gets a new one', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    await h.prepareLaunch('s1', FAKE, spec());
    await h.prepareLaunch('s1', FAKE, spec());
    expect(h.calls).toHaveLength(1);
    h.sessions.set('s2', session('s2', { mcpHandle: 'fake-1' }));
    await h.prepareLaunch('s2', FAKE, spec());
    expect(h.sessions.get('s2')?.mcpHandle).toBe('fake-2');
  });

  it('onExit revokes the token and deletes the launch config', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await launch(h, 's1');
    const c = await client(h.ep, token);
    const closed = new Promise<void>((r) => c.sock.on('close', () => r()));
    const cfg = path.join(h.dir, 'launch', 's1.json');
    expect(fs.existsSync(cfg)).toBe(true);
    h.exit('s1');
    expect(h.tokens.rows()).toMatchObject({ state: 'loaded', rows: [] });
    await closed;
    await expect.poll(() => fs.existsSync(cfg)).toBe(false);
    const again = await client(h.ep, token);
    expect((await again.call('list_sessions')).body.error.code).toBe('not_in_session');
  });

  it('a connection that said hello but had not initialized does not survive the exit', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await launch(h, 's1');
    const c = await helloOnly(h.ep, token);
    const list = (await c.request(1, 'tools/list')) as { result: { tools: unknown[] } };
    expect(list.result.tools.length).toBeGreaterThan(0);
    h.exit('s1');
    h.alive.delete('s1');
    await c.closed;
    expect(h.host.uiState().sessions.s1?.connected).toBe(false);
  });

  it('initialize on a connection whose token was re-minted does not make the session live', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await launch(h, 's1');
    const c = await helloOnly(h.ep, token);
    await c.request(1, 'tools/list');
    await h.prepareLaunch('s1', FAKE, spec());
    const init = c.request(2, 'initialize', { protocolVersion: '2025-06-18' });
    await Promise.race([init, c.closed]);
    await c.closed;
    expect(h.host.uiState().sessions.s1?.connected).toBe(false);
  });

  it('a revoked token is refused by an already-initialized connection', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await launch(h, 's1');
    const c = await client(h.ep, token);
    await h.prepareLaunch('s1', FAKE, spec());
    const r = await c.call('list_sessions');
    expect(r.body.error.code).toBe('not_in_session');
  });

  it('a handles.json or launch-config write failure → unchanged + unavailable launch-io', async () => {
    const h = harness();
    await h.host.start();
    fs.mkdirSync(path.join(h.dir, 'handles.json'));
    h.sessions.set('s1', session('s1'));
    const sp = spec();
    expect(await h.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    fs.rmSync(path.join(h.dir, 'handles.json'), { recursive: true });
    h.sessions.set('s2', session('s2'));
    fs.mkdirSync(path.join(h.dir, 'launch', 's2.json'), { recursive: true });
    expect(await h.prepareLaunch('s2', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s2?.unavailable).toBe('launch-io');
  });

  it('a launch before the endpoint listens gets no wiring and reads endpoint-down', async () => {
    const h = harness();
    h.sessions.set('s1', session('s1'));
    const sp = spec();
    expect(await h.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    await h.host.start();
    const wired = await h.prepareLaunch('s1', FAKE, sp);
    expect(wired.env?.CONDUIT_SESSION_TOKEN).toBeDefined();
    expect(h.host.uiState().sessions.s1?.unavailable).toBeNull();
  });

  it('the endpoint listens before the store loads', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const io: StoreIo = {
      readLog: async () => {
        await gate;
        return undefined;
      },
      appendLog: async () => {},
      rewriteLog: async () => {},
      writeBlob: async () => {},
      readBlob: async () => undefined,
      deleteBlob: async () => {},
      listBlobs: async () => [],
      sweepPartialBlobs: async () => {},
    };
    const h = harness({ storeIo: io });
    const started = h.host.start();
    await expect
      .poll(() => {
        h.sessions.set('s1', session('s1'));
        return h.prepareLaunch('s1', FAKE, spec()).then((out) => out.env?.CONDUIT_SESSION_TOKEN);
      })
      .toBeDefined();
    expect(h.host.uiState().loading).toBe(true);
    release();
    await started;
  });

  it('stop waits for an in-flight store repair', async () => {
    let release = () => {};
    let entered = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const io: StoreIo = {
      readLog: async () => '{',
      appendLog: async () => {},
      rewriteLog: async () => {
        entered();
        await blocked;
      },
      writeBlob: async () => {},
      readBlob: async () => undefined,
      deleteBlob: async () => {},
      listBlobs: async () => [],
      sweepPartialBlobs: async () => {},
    };
    const h = harness({
      storeIo: io,
      createEndpoint: () => ({
        listen: async () => ({ ok: true, value: undefined }),
        close: async () => {},
      }),
    });
    const started = h.host.start();
    await writing;
    let stopped = false;
    const stopping = h.host.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(stopped).toBe(false);
    } finally {
      release();
    }
    await stopping;
    await started;
  });

  it('stop waits for a launch reservation before returning', async () => {
    const h = harness();
    h.sessions.set('s1', session('s1'));
    let release = () => {};
    let entered = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reserving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reserve = h.tokens.reserve.bind(h.tokens);
    vi.spyOn(h.tokens, 'reserve').mockImplementation(async (...args) => {
      entered();
      await blocked;
      return reserve(...args);
    });
    const launch = h.prepareLaunch('s1', FAKE, spec());
    await reserving;
    let stopped = false;
    const stopping = h.host.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(stopped).toBe(false);
    } finally {
      release();
    }
    await stopping;
    await launch;
    expect(fs.existsSync(path.join(h.dir, 'handles.json'))).toBe(false);
  });

  it('a tick that throws is logged, not left unhandled', async () => {
    const errors: string[] = [];
    const h = harness({
      tickMs: 5,
      log: { ...noLog, error: (_scope, msg) => errors.push(msg) },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await h.host.start();
      await launch(h, 's1');
      // The activity tracker is read only by the tick, so the throw stays inside it.
      h.busy.has = () => {
        throw new Error('boom');
      };
      await expect.poll(() => errors.length, { timeout: 2_000 }).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stop waits for the startup directory sweep and prevents subsequent writes', async () => {
    const h = harness({
      createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
    });
    let release = () => {};
    let entered = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sweeping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args) => {
      if (args[0] === path.join(h.dir, 'launch')) {
        entered();
        await blocked;
      }
      return original(...args);
    });
    try {
      void h.host.start();
      await sweeping;
      let stopped = false;
      const stopping = h.host.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(fs.existsSync(path.join(h.dir, 'launch'))).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('start sweeps launch configs left by a crash', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.dir, 'launch'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'launch', 'old.json'), '{}');
    await h.host.start();
    expect(fs.existsSync(path.join(h.dir, 'launch', 'old.json'))).toBe(false);
  });
});

describe('createConduitMcpHost — tools over the endpoint', () => {
  it('projects exact unread-message counts per thread for the header scope tooltip', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await launch(h, 's1');
    const c = await client(h.ep, token);
    const first = await c.call('send_message', { to: ['you'], body: 'first' });
    expect(first.isError).toBe(false);
    const threadId = first.body.thread_id as string;
    await c.call('send_message', { to: ['you'], body: 'second', thread_id: threadId });
    const state = h.host.uiState();
    expect(state.youUnread).toBe(2);
    expect(state.youUnreadByThread).toEqual([
      { participants: expect.arrayContaining(['you', 'fake-1']), count: 2 },
    ]);
  });

  it('a socket with a valid token sends; recipient gets queued; mcp:state broadcast', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    await launch(h, 's2');
    const c = await client(h.ep, a.token);
    const sessions = await c.call('list_sessions');
    expect(sessions.body.sessions.map((s: { handle: string }) => s.handle)).toEqual([
      'fake-1',
      'fake-2',
    ]);
    const sent = await c.call('send_message', { to: ['fake-2'], body: 'hi' });
    expect(sent.isError).toBe(false);
    expect(sent.body.recipients).toEqual([{ handle: 'fake-2', status: 'queued' }]);
    const st = await lastState(h);
    expect(h.broadcasts.some((b) => b.type === 'mcp:state')).toBe(true);
    expect(st.sessions.s2?.unread).toBe(1);
    expect(st.threads).toHaveLength(1);
  });

  it('list_sessions omits a session that has no handle', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    h.sessions.set('s2', session('s2'));
    h.alive.add('s2');
    const c = await client(h.ep, a.token);
    const sessions: unknown[] = (await c.call('list_sessions')).body.sessions;
    expect(h.sessions.get('s2')?.mcpHandle).toBeUndefined();
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain('S s2');
  });

  it('invalid token → tools/list [] and not_in_session', async () => {
    const h = harness();
    await h.host.start();
    await launch(h, 's1');
    const c = await client(h.ep, 'forged');
    const list = (await c.request('tools/list')) as { result: { tools: unknown[] } };
    expect(list.result.tools).toEqual([]);
    expect((await c.call('send_message', { to: ['fake-1'], body: 'x' })).body.error.code).toBe(
      'not_in_session',
    );
    const none = await client(h.ep, null);
    expect((await none.call('list_sessions')).body.error.code).toBe('not_in_session');
  });

  it('logs calls rejected before the tool runs', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    await h.host.start();
    const a = await launch(h, 's1');
    const forged = await client(h.ep, 'forged');
    await forged.call('list_sessions');
    const c = await client(h.ep, a.token);
    await c.call('list_sessions');
    expect(rec.of('tool call').map((e) => e.data)).toEqual([
      { tool: 'list_sessions', handle: undefined, ok: false, code: 'not_in_session' },
      { tool: 'list_sessions', handle: 'fake-1', ok: true },
    ]);
  });

  it('messaging turned off → messaging_off', async () => {
    let on = true;
    const h = harness({ messagingOn: () => on });
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    on = false;
    expect((await c.call('list_sessions')).body.error.code).toBe('messaging_off');
  });

  it('mcp:compose as you', async () => {
    const h = harness();
    await h.host.start();
    await launch(h, 's1');
    const replies: HostToWebview[] = [];
    await h.host.handleRenderer(
      {
        type: 'mcp:compose',
        requestId: 7,
        to: ['fake-1'],
        body: 'from the human',
        priority: 'normal',
        kind: 'request',
      },
      (m) => replies.push(m),
      1,
    );
    expect(replies).toHaveLength(1);
    const r = replies[0];
    expect(r.type === 'mcp:sent' && r.requestId === 7 && r.result.ok).toBe(true);
    const st = h.host.uiState();
    expect(st.threads[0]?.participants).toEqual(expect.arrayContaining(['you', 'fake-1']));
    expect(st.sessions.s1?.unread).toBe(1);
  });

  it('onSessionDeleted marks unread undelivered', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    await launch(h, 's2');
    const c = await client(h.ep, a.token);
    const sent = await c.call('send_message', { to: ['fake-2'], body: 'hi' });
    await h.host.onSessionDeleted('s2');
    h.sessions.delete('s2');
    const replies: HostToWebview[] = [];
    await h.host.handleRenderer(
      { type: 'mcp:thread:get', requestId: 1, threadId: sent.body.thread_id },
      (m) => replies.push(m),
      1,
    );
    const r = replies[0];
    expect(r.type === 'mcp:thread' && r.thread?.messages[0]?.recipients['fake-2']?.status).toBe(
      'undelivered',
    );
  });
});

describe('createConduitMcpHost — notices', () => {
  async function pair(h: Harness) {
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const cb = await ready(h, 's2');
    settle(h);
    return { ca, cb };
  }

  /** s2 runs the queue adapter: busy does not hold its notice (spec CON-172). */
  async function pairQueue(h: Harness) {
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const b = await launch(h, 's2', FAKE_QUEUE);
    await client(h.ep, b.token);
    h.output('s2', 'fake❯ ');
    h.echo.add('s2');
    settle(h);
    return { ca, handle: h.sessions.get('s2')?.mcpHandle ?? '' };
  }

  it('idle prompt + quiet + settled + live connection → notice text, the echo, then "\\r"', async () => {
    const h = harness();
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    expect(h.host.uiState().sessions.s2?.gate).toBe('open');
    // Noticed now: the spacing holds the next one, and a re-tick types nothing new.
    await h.host.tick();
    expect(writesTo(h, 's2')).toHaveLength(2);
  });

  it('no echo on screen after the gap → no "\\r", unsent-notice attention', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.echo.delete('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['unsent-notice']);
  });

  it('typed text that renders only after the submit gap (Codex) still gets its Enter', async () => {
    const h = harness({ lagEcho: true });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    expect(h.host.uiState().attention).toEqual([]);
  });

  it('a human keystroke during the echo wait withholds the Enter', async () => {
    const h = harness({ lagEcho: true, duringWait: (host) => host.noteHostInput('s2', 'x') });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['unsent-notice']);
  });

  it('logs the notice lifecycle and gate transitions, once per change', async () => {
    const rec = recordingLog();
    const h = harness({ lagEcho: true, echoSubmit: true, log: rec.log });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'a-private-body' });
    await h.host.tick();
    await h.host.tick();
    const lifecycle = () =>
      rec.entries
        .filter((e) => e.msg.startsWith('notice') && e.data?.sessionId === 's2')
        .map((e) => [e.level, e.msg, e.data]);
    await expect.poll(lifecycle).toEqual([
      ['info', 'notice typed', { sessionId: 's2', handle: 'fake-2' }],
      [
        'info',
        'notice echo',
        { sessionId: 's2', handle: 'fake-2', verdict: 'echoed', waitedMs: ECHO_POLL_MS },
      ],
      ['info', 'notice result', { sessionId: 's2', handle: 'fake-2', outcome: 'submitted' }],
      ['info', 'notice submit confirmed', { sessionId: 's2', handle: 'fake-2', waitedMs: 0 }],
    ]);
    // Precheck and the slot's recheck both read 'open': one line. The per-tick badge pass, which
    // reads 'spacing' afterwards with nothing due, logs nothing.
    expect(rec.of('gate').map((e) => [e.data?.sessionId, e.data?.from, e.data?.to])).toEqual([
      ['s2', null, 'open'],
    ]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('spacing');
    expect(rec.entries.every((e) => e.scope === 'conduit-mcp')).toBe(true);
    expect(JSON.stringify(rec.entries)).not.toContain('a-private-body');
  });

  it('logs an Enter the CLI did not take as unconfirmed', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    // ~40 screen snapshots before the bound: slow on a loaded machine.
    await expect
      .poll(() => rec.of('notice submit unconfirmed').map((e) => [e.level, e.data?.sessionId]), {
        timeout: 15_000,
      })
      .toEqual([['warn', 's2']]);
  });

  it('logs a withheld notice with its reason', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    const { ca } = await pair(h);
    h.echo.delete('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(rec.of('notice echo').map((e) => [e.level, e.data?.verdict])).toEqual([
      ['info', 'no-echo'],
    ]);
    expect(rec.of('notice result').map((e) => e.data?.outcome)).toEqual(['withheld']);
  });

  describe('unread banner on tool results (CON-153)', () => {
    const BANNER_TWO = '[conduit] 2 unread messages from fake-1. Call read_inbox.';

    it('a recipient learns of unread messages in every tool result until read_inbox reads them', async () => {
      const h = harness();
      const { ca, cb } = await pair(h);
      await ca.call('send_message', { to: ['fake-2'], body: 'one' });
      await ca.call('send_message', { to: ['fake-2'], body: 'two' });
      const first = await cb.call('list_sessions');
      expect(first.content).toHaveLength(2);
      expect(first.content[1].text).toBe(BANNER_TWO);
      expect(first.body.sessions).toBeDefined();
      expect((await cb.call('list_sessions')).content[1].text).toBe(BANNER_TWO);
      await cb.call('read_inbox');
      expect((await cb.call('list_sessions')).content).toHaveLength(1);
    });

    it('the banner marks nothing, so a typed notice still goes in when the gate opens', async () => {
      const h = harness();
      const { ca, cb } = await pair(h);
      await h.host.tick();
      await ca.call('send_message', { to: ['fake-2'], body: 'one' });
      expect((await cb.call('list_sessions')).content).toHaveLength(2);
      await h.host.tick();
      expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    });

    it('an urgent message to a busy recipient still raises urgent-waiting while the banner shows', async () => {
      const h = harness();
      const { ca, cb } = await pair(h);
      h.busy.add('s2');
      await ca.call('send_message', { to: ['fake-2'], body: 'now', priority: 'urgent' });
      expect((await cb.call('list_sessions')).content).toHaveLength(2);
      await h.host.tick();
      expect(writesTo(h, 's2')).toEqual([]);
      expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['urgent-waiting']);
    });

    it('read_inbox itself carries no banner', async () => {
      const h = harness();
      const { ca, cb } = await pair(h);
      await ca.call('send_message', { to: ['fake-2'], body: 'one' });
      expect((await cb.call('read_inbox')).content).toHaveLength(1);
    });

    it('fyi-only mail carries no banner', async () => {
      const h = harness();
      const { ca, cb } = await pair(h);
      await ca.call('send_message', { to: ['fake-2'], body: 'note', priority: 'fyi' });
      expect((await cb.call('list_sessions')).content).toHaveLength(1);
    });
  });

  describe('late-echo watcher', () => {
    const ECHO_AT_MS = 5_000;
    const pollsTo = (ms: number) => ms / LATE_ECHO_POLL_MS;

    async function withheldLateEcho(h: Harness, ca: Awaited<ReturnType<typeof client>>) {
      h.echo.delete('s2');
      await ca.call('send_message', { to: ['fake-2'], body: 'see' });
      await h.host.tick();
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
      await waitLateEchoHeld(h);
    }

    async function expectSilentCancel(rec: ReturnType<typeof recordingLog>, h: Harness) {
      await new Promise((r) => setTimeout(r, 50));
      const o = lateEchoOutcomes(rec);
      expect(o.submitted).toHaveLength(0);
      expect(o.abandoned).toHaveLength(0);
      expect(o.expired).toHaveLength(0);
      expect(writesTo(h, 's2').filter((d) => d === '\r')).toEqual([]);
    }

    it('echo appears at +5 s after withheld → exactly one Enter, then confirm', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, echoSubmit: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      const start = h.clock.t;
      for (let i = 0; i < pollsTo(ECHO_AT_MS) - 1; i += 1) {
        await h.releaseLateEcho();
        await waitLateEchoHeld(h);
      }
      h.echo.add('s2');
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      expect(h.clock.t - start).toBe(ECHO_AT_MS);
      await expect.poll(() => writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
      expect(lateEchoOutcomes(rec).submitted).toHaveLength(1);
      expect(lateEchoOutcomes(rec).submitted[0]?.data?.waitedMs).toBe(ECHO_AT_MS);
      await expect.poll(() => rec.of('notice submit confirmed').length).toBe(1);
      expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    });

    it('late Enter queued behind a running submit: human key in the gap → no second \\r', async () => {
      const rec = recordingLog();
      const h = harness({ holdGaps: true, holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      h.echo.delete('s2');
      await ca.call('send_message', { to: ['fake-2'], body: 'see' });
      const tickP = h.host.tick();
      await expect.poll(() => h.gaps.length).toBe(1);
      h.gaps.shift()?.();
      await tickP;
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
      await waitLateEchoHeld(h);

      const timed = h.writer.submit('s2', 'timed');
      await expect.poll(() => h.gaps.length).toBe(1);
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expect.poll(() => h.submitEnterCalls).toBe(1);

      h.host.noteHostInput('s2', 'x');
      h.gaps.shift()?.();
      expect(await timed).toBe('submitted');
      await expect.poll(() => lateEchoOutcomes(rec).abandoned.length).toBe(1);
      expect(lateEchoOutcomes(rec).abandoned[0]?.data?.reason).toBe('draft');
      expect(writesTo(h, 's2')).toEqual([composeNotice(false), 'timed', '\r']);
      expect(lateEchoOutcomes(rec).submitted).toHaveLength(0);
    });

    it('late Enter marks pending messages as noticed', async () => {
      const h = harness({ holdLateEcho: true });
      const { ca } = await pair(h);
      h.echo.delete('s2');
      const sent = await ca.call('send_message', { to: ['fake-2'], body: 'see' });
      await h.host.tick();
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
      await waitLateEchoHeld(h);
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expect.poll(() => writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
      const threadId = sent.body.thread_id as string;
      await expect
        .poll(async () => {
          const replies: HostToWebview[] = [];
          await h.host.handleRenderer(
            { type: 'mcp:thread:get', requestId: 1, threadId },
            (m) => replies.push(m),
            1,
          );
          const r = replies[0];
          return r.type === 'mcp:thread'
            ? r.thread?.messages[0]?.recipients['fake-2']?.status
            : undefined;
        })
        .toBe('noticed');
    });

    it('human keystroke before the late echo → no Enter, abandoned (draft)', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      h.host.noteHostInput('s2', 'x');
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expect.poll(() => lateEchoOutcomes(rec).abandoned.length).toBe(1);
      expect(lateEchoOutcomes(rec).abandoned[0]?.data?.reason).toBe('draft');
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    });

    it('echo never appears → expired at 30 s, no Enter', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      const start = h.clock.t;
      for (let i = 0; i < pollsTo(LATE_ECHO_WAIT_MS) - 1; i += 1) {
        await h.releaseLateEcho();
        await waitLateEchoHeld(h);
      }
      await h.releaseLateEcho();
      await expect.poll(() => lateEchoOutcomes(rec).expired.length).toBe(1);
      expect(h.clock.t - start).toBe(LATE_ECHO_WAIT_MS);
      expect(lateEchoOutcomes(rec).expired[0]?.data?.waitedMs).toBe(LATE_ECHO_WAIT_MS);
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    });

    it('session restarts (generation change) → abandoned (not-running)', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      h.respawn('s2', 40, 24);
      await h.releaseLateEcho();
      await expect.poll(() => lateEchoOutcomes(rec).abandoned.length).toBe(1);
      expect(lateEchoOutcomes(rec).abandoned[0]?.data?.reason).toBe('not-running');
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    });

    it('blocking prompt appears → abandoned (blocking-prompt)', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      h.output('s2', '\x1b[2J\x1b[1;1Hfake❯ \x1b[17;1HEsc to cancel\x1b[1;7H');
      await h.releaseLateEcho();
      await expect.poll(() => lateEchoOutcomes(rec).abandoned.length).toBe(1);
      expect(lateEchoOutcomes(rec).abandoned[0]?.data?.reason).toBe('blocking-prompt');
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    });

    it('normal path (echo within 2 s) unchanged: no late watcher started', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await ca.call('send_message', { to: ['fake-2'], body: 'see' });
      await h.host.tick();
      expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
      expect(h.lateEchoSleeps).toHaveLength(0);
      expect(lateEchoOutcomes(rec).submitted).toHaveLength(0);
      expect(lateEchoOutcomes(rec).abandoned).toHaveLength(0);
      expect(lateEchoOutcomes(rec).expired).toHaveLength(0);
    });

    it('session exit cancels the watcher, no Enter', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      h.exit('s2');
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expectSilentCancel(rec, h);
    });

    it('session delete cancels the watcher, no Enter', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      await h.host.onSessionDeleted('s2');
      h.sessions.delete('s2');
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expectSilentCancel(rec, h);
    });

    it('host stop cancels the watcher, no Enter', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      await h.host.stop();
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expectSilentCancel(rec, h);
    });

    it('a superseding notice cancels the old watcher', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      h.echo.delete('s2');
      await ca.call('send_message', { to: ['fake-2'], body: 'first' });
      await h.host.tick();
      expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
      await waitLateEchoHeld(h, 1);
      h.clock.t += NOTICE_SPACING_MS;
      await ca.call('send_message', { to: ['fake-2'], body: 'second' });
      await h.host.tick();
      expect(writesTo(h, 's2')).toEqual([composeNotice(false), composeNotice(false)]);
      await waitLateEchoHeld(h, 2);
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expectSilentCancel(rec, h);
    });

    it('in-slot no-echo (startup repaint) resumes polling', async () => {
      const rec = recordingLog();
      const h = harness({ holdGaps: true, holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      h.echo.delete('s2');
      await ca.call('send_message', { to: ['fake-2'], body: 'see' });
      const tickP = h.host.tick();
      await expect.poll(() => h.gaps.length).toBe(1);
      h.gaps.shift()?.();
      await tickP;
      await waitLateEchoHeld(h);

      const timed = h.writer.submit('s2', 'timed');
      await expect.poll(() => h.gaps.length).toBe(1);
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expect.poll(() => h.submitEnterCalls).toBe(1);
      h.output('s2', '\x1b[2J\x1b[1;1Hfake❯ ');
      h.gaps.shift()?.();
      expect(await timed).toBe('submitted');
      expect(lateEchoOutcomes(rec).abandoned).toHaveLength(0);
      await waitLateEchoHeld(h);
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expect.poll(() => lateEchoOutcomes(rec).submitted.length).toBe(1);
      expect(writesTo(h, 's2').filter((d) => d === '\r')).toEqual(['\r', '\r']);
    });

    it('a write-failed slot logs an outcome, no silent end', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      h.failEnter.add('s2');
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expect.poll(() => lateEchoOutcomes(rec).abandoned.length).toBe(1);
      expect(lateEchoOutcomes(rec).abandoned[0]?.data?.reason).toBe('write-failed');
      expect(writesTo(h, 's2').filter((d) => d === '\r')).toEqual([]);
    });

    it('late submit refreshes lastNoticeAt (spacing from the Enter, not the withhold)', async () => {
      const rec = recordingLog();
      const h = harness({ holdLateEcho: true, echoSubmit: true, log: rec.log });
      const { ca } = await pair(h);
      await withheldLateEcho(h, ca);
      for (let i = 0; i < pollsTo(ECHO_AT_MS) - 1; i += 1) {
        await h.releaseLateEcho();
        await waitLateEchoHeld(h);
      }
      h.echo.add('s2');
      h.output('s2', composeNotice(false));
      await h.releaseLateEcho();
      await expect.poll(() => lateEchoOutcomes(rec).submitted.length).toBe(1);
      expect(lateEchoOutcomes(rec).submitted[0]?.data?.waitedMs).toBe(ECHO_AT_MS);
      await expect.poll(() => rec.of('notice submit confirmed').length).toBe(1);
      await h.host.tick();
      expect(h.host.uiState().sessions.s2?.gate).toBe('spacing');
      h.clock.t += NOTICE_SPACING_MS - ECHO_AT_MS + 1_000;
      await h.host.tick();
      expect(h.host.uiState().sessions.s2?.gate).toBe('spacing');
      h.clock.t += ECHO_AT_MS;
      await h.host.tick();
      expect(h.host.uiState().sessions.s2?.gate).not.toBe('spacing');
    });
  });

  it('logs MCP connects, disconnects and tool calls by name and caller, never their bodies', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    await launch(h, 's2');
    await ca.call('send_message', { to: ['fake-2'], body: 'a-private-body' });
    await ca.call('read_attachment', { message_id: 'nope', attachment_id: 'nope' });
    expect(
      rec.of('mcp connected').map((e) => [e.level, e.data?.sessionId, e.data?.handle]),
    ).toEqual([['info', 's1', 'fake-1']]);
    expect(rec.of('tool call').map((e) => e.data)).toEqual([
      { tool: 'send_message', handle: 'fake-1', ok: true },
      { tool: 'read_attachment', handle: 'fake-1', ok: false, code: expect.any(String) },
    ]);
    ca.sock.destroy();
    await expect
      .poll(() => rec.of('mcp disconnected').map((e) => [e.data?.sessionId, e.data?.handle]))
      .toEqual([['s1', 'fake-1']]);
    expect(JSON.stringify(rec.entries)).not.toContain('a-private-body');
  });

  it('gate closes between precheck and slot (renderer input) → gate-closed, nothing written', async () => {
    const h = harness({ holdGaps: true });
    const { ca } = await pair(h);
    h.echo.delete('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    // A timed message holds the session's writer slot while the notifier prechecks (open).
    const timed = h.writer.submit('s2', 'timed');
    await expect.poll(() => h.gaps.length).toBe(1);
    const tickP = h.host.tick();
    await expect.poll(() => h.host.uiState().sessions.s2?.gate).toBe('open');
    await new Promise((r) => setTimeout(r, 50));
    // The human types after the precheck and before the notice's slot opens.
    h.host.onRendererInput('s2', 'f');
    h.gaps.shift()?.();
    expect(await timed).toBe('submitted');
    await tickP;
    expect(writesTo(h, 's2')).toEqual(['timed', '\r']);
    expect(h.host.uiState().sessions.s2?.gate).toBe('draft');
  });

  it('host-originated input inside the submit gap (add-dir paste) withholds the Enter', async () => {
    const h = harness({ holdGaps: true });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    const tickP = h.host.tick();
    await expect.poll(() => h.gaps.length).toBe(1);
    h.host.noteHostInput('s2', '\x1b[200~/add-dir /x\x1b[201~');
    h.gaps.shift()?.();
    await tickP;
    expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['unsent-notice']);
  });

  it('blocking screen 15 rows below the cursor → no submit', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.output('s2', '\x1b[2J\x1b[1;1Hfake❯ \x1b[17;1HEsc to cancel\x1b[1;7H');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('blocking-prompt');
  });

  it('renderer input "fix the" → no submit until "\\r"', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.host.onRendererInput('s2', 'fix the');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('draft');
    h.host.onRendererInput('s2', '\r');
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it('draft cleared after empty-input + 3 s without input', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.host.onRendererInput('s2', 'x');
    h.host.onRendererInput('s2', '\x7f');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    h.clock.t += 2_999;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    h.clock.t += 1;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it('focus report input does not count as draft', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.host.onRendererInput('s2', '\x1b[I');
    h.host.onRendererInput('s2', '\x1b[O');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it('busy recipient → nothing written; urgent raises attention once; idle then one notice', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.busy.add('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'now', priority: 'urgent' });
    await h.host.tick();
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['urgent-waiting']);
    h.busy.delete('s2');
    h.lastOut.set('s2', h.clock.t);
    h.clock.t += 3_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(true), '\r']);
    await expect.poll(() => h.host.uiState().attention.map((a) => a.reason)).toEqual([]);
  });

  it('queue adapter busy at an empty prompt → notice + Enter', async () => {
    const h = harness();
    const { ca, handle } = await pairQueue(h);
    h.busy.add('s2');
    await ca.call('send_message', { to: [handle], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it('queue adapter busy with a draft → nothing written', async () => {
    const h = harness();
    const { ca, handle } = await pairQueue(h);
    h.busy.add('s2');
    h.host.onRendererInput('s2', 'fix the');
    await ca.call('send_message', { to: [handle], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('draft');
  });

  it('queue adapter on a permission prompt → nothing written', async () => {
    const h = harness();
    const { ca, handle } = await pairQueue(h);
    h.busy.add('s2');
    h.output('s2', '\x1b[2J\x1b[1;1Hfake❯ \x1b[17;1HEsc to cancel\x1b[1;7H');
    await ca.call('send_message', { to: [handle], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('blocking-prompt');
  });

  it('queue adapter: a permission prompt appearing between the two reads → nothing written', async () => {
    const h = harness({
      onStableWait: () => h.output('s2', '\x1b[2J\x1b[1;1Hfake❯ \x1b[17;1HEsc to cancel\x1b[1;7H'),
    });
    const { ca, handle } = await pairQueue(h);
    h.busy.add('s2');
    await ca.call('send_message', { to: [handle], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('blocking-prompt');
  });

  it('queue adapter: two open reads → notice and Enter written', async () => {
    let stableWaits = 0;
    const h = harness({ onStableWait: () => void stableWaits++ });
    const { ca, handle } = await pairQueue(h);
    h.busy.add('s2');
    await ca.call('send_message', { to: [handle], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    expect(stableWaits).toBe(1);
  });

  it('hold adapter: no second screen read', async () => {
    let stableWaits = 0;
    const h = harness({ onStableWait: () => void stableWaits++ });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    expect(stableWaits).toBe(0);
  });

  it('queue adapter: urgent message while busy at an empty prompt is delivered with the (urgent) text, never Esc or Ctrl+C', async () => {
    const h = harness();
    const { ca, handle } = await pairQueue(h);
    h.busy.add('s2');
    await ca.call('send_message', { to: [handle], body: 'now', priority: 'urgent' });
    h.clock.t += 1_000;
    await h.host.tick();
    const writes = writesTo(h, 's2');
    expect(writes).toEqual([composeNotice(true), '\r']);
    for (const w of writes) {
      expect(w).not.toContain('\x1b');
      expect(w).not.toContain('\x03');
    }
  });

  it('second message while the queued notice is unread → no second write', async () => {
    const h = harness();
    const { ca, handle } = await pairQueue(h);
    h.busy.add('s2');
    await ca.call('send_message', { to: [handle], body: 'one' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    await ca.call('send_message', { to: [handle], body: 'two' });
    h.clock.t += 31_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toHaveLength(2);
  });

  it('paused → no submit; badge gate "paused"', async () => {
    const h = harness();
    const { ca } = await pair(h);
    await h.host.handleRenderer(
      { type: 'mcp:pause', sessionId: 's2', paused: true },
      () => undefined,
      1,
    );
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2).toMatchObject({ paused: true, gate: 'paused', unread: 1 });
  });

  it('codex session gets a handle and is never typed into while its own prompt is not on screen', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    h.sessions.set('s3', session('s3', { agentId: 'codex' }));
    const c = await launch(h, 's3', CODEX, spec('/usr/bin/codex'));
    expect(c.spec.args.filter((x) => x === '-c')).toHaveLength(6);
    await client(h.ep, c.token);
    h.output('s3', 'fake❯ ');
    settle(h);
    await ca.call('send_message', { to: ['codex-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's3')).toEqual([]);
    expect(h.host.uiState().sessions.s3).toMatchObject({
      handle: 'codex-1',
      gate: 'no-empty-input',
    });
  });

  it('claude session whose input row holds only a dim suggested prompt gets its notice', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    h.sessions.set('s4', session('s4', { agentId: 'claude' }));
    const c = await launch(h, 's4', CLAUDE, spec('/usr/bin/claude'));
    await client(h.ep, c.token);
    // Claude 2.1.310 after a turn: bare prompt, a faint suggestion, cursor parked before it.
    h.output('s4', '❯ \x1b[2myes, go ahead\x1b[22m\x1b[3G');
    h.echo.add('s4');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 's4')).toEqual([composeNotice(false), '\r']);
  });

  it('claude session with typed (normal-weight) text on the input row is not typed into', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    h.sessions.set('s4', session('s4', { agentId: 'claude' }));
    const c = await launch(h, 's4', CLAUDE, spec('/usr/bin/claude'));
    await client(h.ep, c.token);
    h.output('s4', '❯ yes, go ahead');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's4')).toEqual([]);
    expect(h.host.uiState().sessions.s4?.gate).toBe('no-empty-input');
  });

  it('no live connection → never typed into', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    await launch(h, 's2');
    h.output('s2', 'fake❯ ');
    h.echo.add('s2');
    settle(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('no-connection');
  });
});

function failingIo(): StoreIo & { fail: boolean; loads: number } {
  const io = {
    fail: true,
    loads: 0,
    log: '',
    async readLog() {
      io.loads += 1;
      if (io.fail) throw new Error('disk gone');
      return io.log || undefined;
    },
    async appendLog(line: string) {
      io.log += line;
    },
    async rewriteLog(text: string) {
      io.log = text;
    },
    async writeBlob() {},
    async readBlob() {
      return undefined;
    },
    async deleteBlob() {},
    async listBlobs() {
      return [];
    },
    async sweepPartialBlobs() {},
  };
  return io;
}

describe('createConduitMcpHost — store', () => {
  it('store load failure → storeError and store_unavailable; mcp:retry reloads; retry while available does not', async () => {
    const io = failingIo();
    const h = harness({ storeIo: io });
    await h.host.start();
    expect(h.host.uiState()).toMatchObject({ loading: false });
    expect(h.host.uiState().storeError).toContain('disk gone');
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    expect((await c.call('list_sessions')).body.error.code).toBe('store_unavailable');
    io.fail = false;
    await h.host.handleRenderer({ type: 'mcp:retry' }, () => undefined, 1);
    expect(io.loads).toBe(2);
    expect(h.host.uiState().storeError).toBeNull();
    await h.host.handleRenderer({ type: 'mcp:retry' }, () => undefined, 1);
    expect(io.loads).toBe(2);
  });

  it('restart: a new host over the same dir re-arms a noticed unread message', async () => {
    const h = harness();
    const a = await (async () => {
      await h.host.start();
      const x = await launch(h, 's1');
      return client(h.ep, x.token);
    })();
    const cb = await ready(h, 's2');
    settle(h);
    await a.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    cb.sock.destroy();
    await h.host.stop();

    const h2 = harness({ dir: h.dir });
    for (const id of ['s1', 's2']) h2.sessions.set(id, { ...(h.sessions.get(id) as Session) });
    await h2.host.start();
    launch(h2, 's1');
    await ready(h2, 's2');
    settle(h2);
    h2.clock.t += 30_000;
    await h2.host.tick();
    expect(writesTo(h2, 's2')).toEqual([composeNotice(false), '\r']);
  });
});

describe('a launch waits for the endpoint (conductor decision: restored sessions get messaging)', () => {
  it('a launch that awaits whenLaunchReady while start() is still listening is wired', async () => {
    const h = harness();
    h.sessions.set('s1', session('s1'));
    const started = h.host.start();
    const t0 = Date.now();
    await h.host.whenLaunchReady();
    // Released by the listen itself, not by the bound.
    expect(Date.now() - t0).toBeLessThan(ENDPOINT_READY_WAIT_MS);
    const out = await h.prepareLaunch('s1', FAKE, spec());
    expect(out.env?.CONDUIT_SESSION_TOKEN).toBeDefined();
    expect(h.host.uiState().sessions.s1?.unavailable).toBeNull();
    await started;
  });

  it('the wait is bounded at 3 s, then the launch reads endpoint-down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness({
        createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
      });
      h.sessions.set('s1', session('s1'));
      void h.host.start();
      let done = false;
      const waited = h.host.whenLaunchReady().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(ENDPOINT_READY_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waited;
      expect(ENDPOINT_READY_WAIT_MS).toBe(3_000);
      const sp = spec();
      expect(await h.prepareLaunch('s1', FAKE, sp)).toBe(sp);
      expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed listen ends the wait at once', async () => {
    const h = harness({
      createEndpoint: () => ({
        listen: async () => ({ ok: false, error: toolError('host_unavailable', 'EADDRINUSE') }),
        close: async () => {},
      }),
    });
    h.sessions.set('s1', session('s1'));
    const started = h.host.start();
    const t0 = Date.now();
    await h.host.whenLaunchReady();
    expect(Date.now() - t0).toBeLessThan(ENDPOINT_READY_WAIT_MS);
    const sp = spec();
    expect(await h.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    await started;
  });

  it('a listen that throws ends the wait at once, and start() still finishes', async () => {
    const h = harness({
      createEndpoint: () => ({
        listen: async () => {
          throw new Error('EACCES');
        },
        close: async () => {},
      }),
    });
    h.sessions.set('s1', session('s1'));
    const started = h.host.start().then(
      () => 'resolved',
      (err: unknown) => `rejected: ${String(err)}`,
    );
    const t0 = Date.now();
    await h.host.whenLaunchReady();
    expect(Date.now() - t0).toBeLessThan(ENDPOINT_READY_WAIT_MS);
    const sp = spec();
    expect(await h.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    expect(await started).toBe('resolved');
  });

  it('B1 a shell restored at start waits too, and is wired once the endpoint listens', async () => {
    const h = harness();
    h.sessions.set('sh', session('sh', { agentId: 'pwsh' }));
    let done = false;
    const waited = h.host.whenLaunchReady().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    const started = h.host.start();
    await waited;
    const out = await h.prepareLaunch('sh', SHELL, spec('/usr/bin/pwsh'));
    expect(out.env?.CONDUIT_SESSION_TOKEN).toBeDefined();
    await started;
  });

  it('B1 the shell wait is bounded at 3 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness({
        createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
      });
      void h.host.start();
      let done = false;
      const waited = h.host.whenLaunchReady().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(ENDPOINT_READY_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waited;
    } finally {
      vi.useRealTimers();
    }
  });

  it('with messaging off nothing waits', async () => {
    const h = harness({
      messagingOn: () => false,
      createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
    });
    void h.host.start();
    let done = 0;
    await Promise.race([
      Promise.all([h.host.whenLaunchReady(), h.host.whenLaunchReady()]).then(() => {
        done = 2;
      }),
      new Promise((r) => setTimeout(r, 50)),
    ]);
    expect(done).toBe(2);
  });
});

describe('control tools: gate, effective tool list, list_changed, session layer (spec 2026-10-30-conduit-mcp-tool-policy §3.3)', () => {
  // Every tool but open_terminal defaults to ask or on (tool-policy spec §3.2).
  const DEFAULT_LIST = TOOL_NAMES.filter((t) => t !== 'open_terminal');
  const policyOf = (h: Harness, id: string, layer: PolicyLayer | undefined) => {
    const s = h.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    s.mcpToolPolicy = layer;
  };
  const settleNotes = () => new Promise((r) => setTimeout(r, 30));

  it('master off → messaging_off for open_session and send_message; tools/list lists every tool', async () => {
    // A launch with the master off is unwired, so this is a CLI started before it was turned off.
    let on = true;
    const h = harness({ messagingOn: () => on });
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    on = false;
    expect(await c.listed()).toEqual([...TOOL_NAMES]);
    expect(
      (await c.call('open_session', { path: '/w', agent: 'e2e-fake-mcp' })).body.error.code,
    ).toBe('messaging_off');
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'messaging_off',
    );
  });

  it('master on, defaults → open_terminal tool_disabled; list is every tool whose access ≠ off', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    expect(await c.listed()).toEqual(DEFAULT_LIST);
    const r = await c.call('open_terminal', { path: '/w', command: 'node' });
    expect(r.body.error.code).toBe('tool_disabled');
  });

  it('tool_disabled precedes store_unavailable', async () => {
    const h = harness({ storeIo: failingIo() });
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    policyOf(h, 's1', { send_message: { access: 'off' } });
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'tool_disabled',
    );
    policyOf(h, 's1', undefined);
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'store_unavailable',
    );
  });

  it('a session layer for one session lists open_terminal only on that connection', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const b = await launch(h, 's2');
    policyOf(h, 's1', { open_terminal: { access: 'ask' } });
    const ca = await client(h.ep, a.token);
    const cb = await client(h.ep, b.token);
    expect(await ca.listed()).toEqual([...TOOL_NAMES]);
    expect(await cb.listed()).toEqual(DEFAULT_LIST);
  });

  it('a policy change sends list_changed once to an initialized connection, not an uninitialized one, not again when unchanged', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    await c.listed();
    const raw = await helloOnly(h.ep, a.token);
    await raw.request(1, 'tools/list');
    const set = async (access: 'on' | 'inherit') => {
      const replies: HostToWebview[] = [];
      await h.host.handleRenderer(
        {
          type: 'mcp:setToolPolicy',
          requestId: 1,
          sessionId: 's1',
          tool: 'open_terminal',
          patch: { access },
        },
        (m) => replies.push(m),
        1,
      );
      return replies;
    };
    await set('on');
    await settleNotes();
    expect(c.notifications).toEqual(['notifications/tools/list_changed']);
    await set('on');
    await settleNotes();
    expect(c.notifications).toHaveLength(1);
    await set('inherit');
    await settleNotes();
    expect(c.notifications).toHaveLength(2);
    expect(raw.notifications).toEqual([]);
  });

  it('settings change via refresh() sends list_changed to affected connections only', async () => {
    let global: GlobalPolicy = DEFAULT_TOOL_POLICY;
    const h = harness({ toolPolicy: () => ({ global, byCli: {} }) });
    await h.host.start();
    const a = await launch(h, 's1');
    const b = await launch(h, 's2');
    policyOf(h, 's2', { open_terminal: { access: 'off' } });
    const ca = await client(h.ep, a.token);
    const cb = await client(h.ep, b.token);
    await ca.listed();
    await cb.listed();
    global = { ...global, open_terminal: { ...global.open_terminal, access: 'on' } };
    h.host.refresh();
    await settleNotes();
    expect(ca.notifications).toEqual(['notifications/tools/list_changed']);
    expect(cb.notifications).toEqual([]);
    expect(await ca.listed()).toEqual([...TOOL_NAMES]);
  });

  it('uiState.switchable lists sessions whose defOf matches an adapter, before any launch', () => {
    const h = harness();
    h.sessions.set('fake', session('fake'));
    h.sessions.set('shell', session('shell', { agentId: 'pwsh' }));
    h.sessions.set('gone', session('gone', { agentId: 'removed-profile' }));
    h.sessions.set('claude', session('claude', { agentId: 'claude' }));
    h.sessions.set(
      'cmd-codex',
      session('cmd-codex', {
        agentId: COMMAND_AGENT_ID,
        command: { command: '/usr/bin/codex', args: [] },
      }),
    );
    h.sessions.set(
      'cmd-node',
      session('cmd-node', { agentId: COMMAND_AGENT_ID, command: { command: 'node', args: [] } }),
    );
    expect(h.host.uiState().switchable).toEqual(['fake', 'claude', 'cmd-codex']);
  });
});

describe('control tools live: claimHandle at create, routing (spec 2026-10-27 §3.1)', () => {
  const on = (h: Harness, id: string, tools: readonly ToolName[]) => {
    const s = h.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    const layer: PolicyLayer = {};
    for (const t of tools) layer[t] = { access: 'on' };
    s.mcpToolPolicy = layer;
  };

  it('open_session with the switch on calls control.openSession and returns the claimed handle', async () => {
    const h = harness({ kinds: { '/w/wt': 'dir' } });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_session']);
    const c = await client(h.ep, a.token);
    const r = await c.call('open_session', { path: 'wt', agent: 'e2e-fake-mcp', focus: false });
    expect(r.isError).toBe(false);
    expect(r.body).toEqual({
      session_id: 'n1',
      handle: 'fake-2',
      label: 'S n1',
      agent: 'e2e-fake-mcp',
    });
    expect(h.opens).toEqual([
      {
        callerSessionId: 's1',
        openedBy: { handle: 'fake-1', sessionId: 's1' },
        home: '/w/wt',
        label: undefined,
        focus: false,
        launch: { kind: 'agent', agentId: 'e2e-fake-mcp' },
        closeWhenDone: false,
      },
    ]);
    expect(h.sessions.get('n1')?.mcpHandle).toBe('fake-2');
  });

  it('open_session with a message stores it from the opener to the new handle (CON-148)', async () => {
    const h = harness({ kinds: { '/w/wt': 'dir' } });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_session']);
    const c = await client(h.ep, a.token);
    const r = await c.call('open_session', {
      path: 'wt',
      agent: 'e2e-fake-mcp',
      focus: false,
      message: 'start on T1',
    });
    expect(r.body).toMatchObject({
      session_id: 'n1',
      handle: 'fake-2',
      message: { id: expect.any(String) },
    });
    const n1 = await launch(h, 'n1');
    const cb = await client(h.ep, n1.token);
    const inbox = await cb.call('read_inbox');
    expect(inbox.body.messages).toHaveLength(1);
    expect(inbox.body.messages[0]).toMatchObject({
      message_id: r.body.message.id,
      from: 'fake-1',
    });
    expect(inbox.body.messages[0].body).toContain('start on T1');
  });

  it('claimHandle at create: a later prepareLaunch keeps the same handle', async () => {
    const h = harness({ kinds: { '/w/wt': 'dir' } });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_session']);
    const c = await client(h.ep, a.token);
    await c.call('open_session', { path: 'wt', agent: 'e2e-fake-mcp' });
    const handles = fs.readFileSync(path.join(h.dir, 'handles.json'), 'utf8');
    await launch(h, 'n1');
    expect(h.sessions.get('n1')?.mcpHandle).toBe('fake-2');
    expect(fs.readFileSync(path.join(h.dir, 'handles.json'), 'utf8')).toBe(handles);
  });

  it('open_terminal: a command with no adapter gets a term handle at create (CON-149)', async () => {
    const h = harness({ kinds: { '/w': 'dir' } });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_terminal']);
    const c = await client(h.ep, a.token);
    const r = await c.call('open_terminal', { path: '/w', command: 'node', args: ['-e', 'x'] });
    expect(r.body).toMatchObject({ session_id: 'n1', handle: 'term-1', agent: 'node' });
    expect(h.sessions.get('n1')?.mcpHandle).toBe('term-1');
  });

  it('open_terminal: a cursor-agent command gets a cursor handle (CON-149)', async () => {
    const h = harness({ kinds: { '/w': 'dir' } });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_terminal']);
    const c = await client(h.ep, a.token);
    const r = await c.call('open_terminal', { path: '/w', command: 'cursor-agent' });
    expect(r.body).toMatchObject({ session_id: 'n1', handle: 'cursor-1' });
  });

  it('open_terminal: a command whose leaf matches an adapter gets a handle at create and MCP wiring at launch', async () => {
    const h = harness({ kinds: { '/w': 'dir' } });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_terminal']);
    const c = await client(h.ep, a.token);
    const r = await c.call('open_terminal', { path: '/w', command: '/opt/bin/claude' });
    expect(r.body).toMatchObject({ session_id: 'n1', handle: 'claude-1', agent: 'claude' });
    const n1 = h.sessions.get('n1');
    if (!n1?.command) throw new Error('n1 has no command');
    const out = await launch(h, 'n1', commandDef(n1.command), spec('/opt/bin/claude'));
    expect(out.token).toEqual(expect.any(String));
    expect(h.sessions.get('n1')?.mcpHandle).toBe('claude-1');
  });

  it('handles.json write failure → handle null, unavailable launch-io', async () => {
    const rec = recordingLog();
    const h = harness({ kinds: { '/w/wt': 'dir' }, log: rec.log });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_session']);
    const c = await client(h.ep, a.token);
    fs.rmSync(path.join(h.dir, 'handles.json'));
    fs.mkdirSync(path.join(h.dir, 'handles.json'));
    const r = await c.call('open_session', { path: 'wt', agent: 'e2e-fake-mcp' });
    expect(r.body).toMatchObject({ session_id: 'n1', handle: null });
    expect(h.sessions.get('n1')?.mcpHandle).toBeUndefined();
    expect(rec.of('handles.json write failed')).toHaveLength(1);
  });

  it('open_file routes to control.openFile', async () => {
    const h = harness({ kinds: { '/w/src/a.ts': 'file' } });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_file']);
    const c = await client(h.ep, a.token);
    const r = await c.call('open_file', { path: 'src/a.ts', line: 3 });
    expect(r.body).toEqual({ opened: '/w/src/a.ts', session_id: 's1' });
    expect(h.files).toEqual([
      { callerSessionId: 's1', path: '/w/src/a.ts', line: 3, column: undefined, focus: true },
    ]);
  });

  it('a control tool with the store down is not store_unavailable', async () => {
    const h = harness({ kinds: { '/w/src/a.ts': 'file' }, storeIo: failingIo() });
    await h.host.start();
    const a = await launch(h, 's1');
    on(h, 's1', ['open_file']);
    const c = await client(h.ep, a.token);
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'store_unavailable',
    );
    const r = await c.call('open_file', { path: 'src/a.ts' });
    expect(r.isError).toBe(false);
  });
});

describe('lazy identity: token for every session, handle from clientInfo (spec 2026-10-27-conduit-mcp-install §3.1, §3.3)', () => {
  const shell = (h: Harness, id: string) => launch(h, id, SHELL, spec('/usr/bin/pwsh'));
  const handlesOf = (body: { sessions: Array<{ handle: string; agent: string }> }) =>
    body.sessions.map((s) => [s.handle, s.agent]);

  it('AC2 first initialize from claude-code allocates claude-<n> before the reply', async () => {
    const h = harness({ recordSends: true });
    await h.host.start();
    const { token } = await shell(h, 'sh1');
    const c = await helloOnly(h.ep, token);
    await c.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'claude-code', version: '2.1.312' },
    });
    const setAt = h.calls.findIndex((x) => x.startsWith('setMcp {"mcpHandle":"claude-1"}'));
    const replyAt = h.calls.findIndex((x) => x.startsWith('send ') && x.includes('"serverInfo"'));
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(replyAt).toBeGreaterThan(setAt);
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'handles.json'), 'utf8'))).toEqual({
      claude: 1,
    });
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).toBe(true);
  });

  it('a server/discover request before initialize is answered -32601 and initialize still connects', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await shell(h, 'sh1');
    const c = await helloOnly(h.ep, token);
    const discover = (await c.request(1, 'server/discover', {})) as {
      error?: { code: number };
    };
    expect(discover.error?.code).toBe(-32601);
    expect(h.sessions.get('sh1')?.mcpHandle).toBeUndefined();
    const init = (await c.request(2, 'initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'claude-code', version: '2.1.312' },
    })) as { result?: { serverInfo: { name: string } } };
    expect(init.result?.serverInfo.name).toBe('conduit');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).toBe(true);
  });

  it('AC2 unknown client → agent-<n>; a missing clientInfo too', async () => {
    const h = harness();
    await h.host.start();
    await client(h.ep, (await shell(h, 'sh1')).token, 'some-ide');
    await client(h.ep, (await shell(h, 'sh2')).token);
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('agent-1');
    expect(h.sessions.get('sh2')?.mcpHandle).toBe('agent-2');
  });

  it('AC2 second CLI in the same shell keeps the handle', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    await client(h.ep, token, 'codex-mcp-client');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    expect(h.calls.filter((c) => c.startsWith('setMcp'))).toHaveLength(1);
  });

  it('AC2 the lazily named session is in list_sessions with agent = live kind, else prefix', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const { token } = await shell(h, 'sh1');
    const claude = await client(h.ep, token, 'claude-code');
    const codex = await client(h.ep, token, 'codex-mcp-client');
    const list = async () => handlesOf((await ca.call('list_sessions')).body);
    await expect.poll(list).toEqual([
      ['fake-1', 'fake'],
      ['claude-1', 'codex'],
    ]);
    // Message history keeps a lazy session listed after its CLIs leave (amendment B2).
    expect((await ca.call('send_message', { to: ['claude-1'], body: 'hi' })).isError).toBe(false);
    codex.sock.destroy();
    await expect.poll(list).toEqual([
      ['fake-1', 'fake'],
      ['claude-1', 'claude'],
    ]);
    claude.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).not.toBe(true);
    expect(await list()).toEqual([
      ['fake-1', 'fake'],
      ['claude-1', 'claude'],
    ]);
  });

  it('B2 a health check does not enrol a shell: after it closes the session is absent', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const check = await client(h.ep, (await shell(h, 'sh1')).token, 'claude-code');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    await expect.poll(() => Object.keys(h.host.uiState().sessions).sort()).toEqual(['s1', 'sh1']);
    check.sock.destroy();
    await expect
      .poll(async () => handlesOf((await ca.call('list_sessions')).body))
      .toEqual([['fake-1', 'fake']]);
    expect(Object.keys(h.host.uiState().sessions)).toEqual(['s1']);
    expect((await ca.call('send_message', { to: ['claude-1'], body: 'x' })).body.error.code).toBe(
      'unknown_session',
    );
  });

  it('an adapter session stays listed without a connection', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    await launch(h, 's2');
    const ca = await client(h.ep, a.token);
    expect(handlesOf((await ca.call('list_sessions')).body).map(([x]) => x)).toEqual([
      'fake-1',
      'fake-2',
    ]);
  });

  it('a forged token initialize allocates nothing', async () => {
    const h = harness();
    await h.host.start();
    await shell(h, 'sh1');
    const c = await client(h.ep, 'forged', 'claude-code');
    expect(await c.listed()).toEqual([]);
    expect(h.sessions.get('sh1')?.mcpHandle).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('N5 a failed lazy claim is cleared by the next launch', async () => {
    const h = harness();
    await h.host.start();
    fs.mkdirSync(path.join(h.dir, 'handles.json'));
    await client(h.ep, (await shell(h, 'sh1')).token, 'claude-code');
    expect(h.sessions.get('sh1')?.mcpHandle).toBeUndefined();
    fs.rmSync(path.join(h.dir, 'handles.json'), { recursive: true });
    const { token } = await shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    await expect.poll(() => h.host.uiState().sessions.sh1?.unavailable).toBeNull();
  });

  it('S1 switchable includes a shell once it has a handle', async () => {
    const h = harness();
    await h.host.start();
    const { token } = await shell(h, 'sh1');
    expect(h.host.uiState().switchable).toEqual([]);
    const c = await client(h.ep, token, 'claude-code');
    expect(h.host.uiState().switchable).toEqual(['sh1']);
    // B2 hides it once the health check closes; its menu item goes with the badge.
    c.sock.destroy();
    await expect.poll(() => h.host.uiState().switchable).toEqual([]);
  });
});

describe('notice adapter from the live client (spec 2026-10-27-conduit-mcp-install §2.4, D6)', () => {
  const shell = (h: Harness, id: string) => launch(h, id, SHELL, spec('/usr/bin/pwsh'));
  async function sender(h: Harness) {
    await h.host.start();
    const a = await launch(h, 's1');
    return client(h.ep, a.token);
  }

  /** `❯ ` is Claude's empty input row, and just as much a starship/pure shell prompt. */
  function idlePrompt(h: Harness, id: string) {
    h.output(id, '❯ ');
    h.echo.add(id);
  }
  /** Claude's ruled input box at `launch`'s 40 cols: a rule, the `❯ ` row holding the cursor, a rule. */
  function claudeBox(h: Harness, id: string) {
    const rule = '─'.repeat(40);
    h.output(id, `${rule}\r\n❯ \r\n${rule}\x1b[1A\r\x1b[2C`);
    h.echo.add(id);
  }

  it('AC3 `claude` typed, then claude-code connects → claude notices', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  it('F1 Claude paints its box before initialize: the lazy model is seeded from the output tail', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.resize('sh1', CLAUDE_BEFORE_INIT.cols, CLAUDE_BEFORE_INIT.rows);
    h.host.onRendererInput('sh1', 'claude --model haiku\r');
    h.output('sh1', CLAUDE_BEFORE_INIT.beforeInitialize);
    await client(h.ep, token, 'claude-code');
    h.output('sh1', CLAUDE_BEFORE_INIT.afterInitialize);
    const snap = await h.screens.snapshot('sh1');
    const claude = MCP_ADAPTERS.find((a) => a.id === 'claude');
    expect(snap && claude && screenVerdict(claude.screen, snap)).toBe('empty-input');
    expect(snap?.lines[(snap?.cursorY ?? 0) - 1]).toMatch(/^─{100,}$/);
    h.echo.add('sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  /** The first row of a model started now: what the session's output tail seeds it with. */
  async function seededRow(h: Harness, id: string) {
    h.screens.start(id, 40, 24);
    return (await h.screens.snapshot(id))?.lines[0];
  }

  it('S6 a shell keeps an output tail whether messaging is on or off', async () => {
    for (const [on, row] of [
      [true, 'before'],
      [false, 'before'],
    ] as const) {
      const h = harness({ messagingOn: () => on });
      await h.host.start();
      await shell(h, 'sh1');
      h.output('sh1', 'before');
      expect(await seededRow(h, 'sh1')).toBe(row);
    }
  });

  it('S6 a profile session keeps no tail: its model starts at spawn', async () => {
    const h = harness();
    await h.host.start();
    const keepTail = vi.spyOn(h.screens, 'keepTail');
    await launch(h, 'c1', CLAUDE);
    expect(keepTail).not.toHaveBeenCalled();
    expect(h.screens.has('c1')).toBe(true);
    await shell(h, 'sh1');
    expect(keepTail).toHaveBeenCalledWith('sh1', 40, 24);
  });

  it('S6 exit and delete drop the tail; a relaunch keeps only the new generation', async () => {
    const h = harness();
    await h.host.start();
    await shell(h, 'ex');
    h.output('ex', 'old');
    h.exit('ex');
    expect(await seededRow(h, 'ex')).toBe('');
    expect(h.tokens.rows()).toMatchObject({ state: 'loaded', rows: [] });

    await shell(h, 'del');
    h.output('del', 'old');
    await h.host.onSessionDeleted('del');
    expect(await seededRow(h, 'del')).toBe('');

    await shell(h, 're');
    h.output('re', 'old');
    await shell(h, 're');
    h.output('re', 'new');
    expect(await seededRow(h, 're')).toBe('new');
  });

  for (const [what, keys] of [
    ['Down+Enter in its trust dialog', '\x1b[B\r'],
    ['a bare Enter', '\r'],
  ] as const) {
    it(`F6 \`claude\`, then ${what} before initialize → still bound`, async () => {
      const h = harness();
      const ca = await sender(h);
      const { token } = await shell(h, 'sh1');
      h.host.onRendererInput('sh1', 'claude\r');
      h.host.onRendererInput('sh1', keys);
      await client(h.ep, token, 'claude-code');
      claudeBox(h, 'sh1');
      settle(h);
      await ca.call('send_message', { to: ['claude-1'], body: 'see' });
      h.clock.t += 1_000;
      await h.host.tick();
      expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
    });
  }

  it('D-F6 `claude`, an untyped Enter 30 s later, then the client → bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    h.clock.t += 30_000;
    h.host.onRendererInput('sh1', '\x1b[B\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  // History recall (Up, Enter) is untyped too, and may re-run `code .` (review S1).
  it('D-F6 `claude`, an untyped Enter 90 s later → a later client is not bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    h.clock.t += 90_000;
    h.host.onRendererInput('sh1', '\x1b[A\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('F6 `claude`, then `ls` → a later client is not bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    h.host.onRendererInput('sh1', 'ls\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: `code .` typed, then a claude-code client connects → nothing typed at the shell prompt', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'code .\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: no line typed at all → pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    await client(h.ep, (await shell(h, 'sh1')).token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: `claude`, connect, a prompt typed into it → still bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    h.host.onRendererInput('sh1', 'fix the failing test\r');
    h.host.onRendererInput('sh1', '\x1b[A\r');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  it('notice rule: `claude`, connect, the connection closes, then `ls` → a later client stays pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const first = await client(h.ep, token, 'claude-code');
    first.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected ?? false).toBe(false);
    h.host.onRendererInput('sh1', 'ls\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: `claude`, connect, Ctrl+Z → pull-only while it is suspended', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    h.host.onRendererInput('sh1', '\x1a');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: a second claude-code client never binds; when the bound one closes → pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const bound = await client(h.ep, token, 'claude-code');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    h.clock.t += 1_000;
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
    bound.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    expect(h.host.uiState().sessions.sh1?.connected).toBe(true);
  });

  it('SF-1 a bound claude with a plain `❯ ` prompt and no rules on screen → nothing typed', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('no-empty-input');
  });

  for (const [key, byte] of [
    ['Ctrl+C', '\x03'],
    ['Ctrl+D', '\x04'],
  ] as const) {
    it(`SF-1 \`claude\` typed, ${key} out of it unconnected, then a claude-code client connects → pull-only`, async () => {
      const h = harness();
      const ca = await sender(h);
      const { token } = await shell(h, 'sh1');
      h.host.onRendererInput('sh1', 'claude\r');
      h.host.onRendererInput('sh1', byte);
      await client(h.ep, token, 'claude-code');
      claudeBox(h, 'sh1');
      settle(h);
      await ca.call('send_message', { to: ['claude-1'], body: 'see' });
      await h.host.tick();
      expect(writesTo(h, 'sh1')).toEqual([]);
      expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    });
  }

  it('SF-3 a relaunch ends the binding even while the old connection is still open', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    await shell(h, 'sh1');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('SF-3 a relaunch drops the typed line: a client of the new generation does not bind', async () => {
    const h = harness();
    const ca = await sender(h);
    await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const { token } = await shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: a connection that initialized before the `claude` line does not count', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    h.host.onRendererInput('sh1', 'claude\r');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
  });

  it('notice rule: `codex` typed, then a claude-code client connects → pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'codex\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: a recalled line the tracker cannot read never binds', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', '\x1b[A\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
  });

  it('AC3 opencode / unmapped client → pull-only, nothing typed', async () => {
    const h = harness();
    const ca = await sender(h);
    const sh1 = await shell(h, 'sh1');
    const sh2 = await shell(h, 'sh2');
    h.host.onRendererInput('sh1', 'opencode\r');
    h.host.onRendererInput('sh2', 'claude\r');
    await client(h.ep, sh1.token, 'opencode');
    await client(h.ep, sh2.token, 'some-ide');
    for (const id of ['sh1', 'sh2']) idlePrompt(h, id);
    settle(h);
    await ca.call('send_message', { to: ['opencode-1', 'agent-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(writesTo(h, 'sh2')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    expect(h.host.uiState().sessions.sh2?.gate).toBe('pull-only');
  });

  it('AC3 no live connection → no notice; badge gate null for a non-adapter session', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const c = await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    await ca.call('send_message', { to: ['claude-1'], body: 'first' });
    c.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).toBe(false);
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBeNull();
  });

  it('AC3 the bound CLI decides; a later client of another CLI or an unmapped one is skipped', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'codex\r');
    const codex = await client(h.ep, token, 'codex-mcp-client');
    await client(h.ep, token, 'claude-code');
    await client(h.ep, token, 'opencode');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['codex-1'], body: 'see' });
    await h.host.tick();
    // Bound to Codex, whose composer is not on screen: Claude's `❯` row never admits the notice.
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('no-empty-input');
    codex.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
  });

  it('definition adapter still wins in a profile session', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = await launch(h, 's2');
    await client(h.ep, token, 'claude-code');
    h.output('s2', 'fake❯ ');
    h.echo.add('s2');
    settle(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it("D6 a shell's screen model starts at its first initialize with the last known size, not at spawn", async () => {
    const h = harness();
    await h.host.start();
    const start = vi.spyOn(h.screens, 'start');
    const { token } = await shell(h, 'sh1');
    h.resize('sh1', 100, 30);
    expect(h.screens.has('sh1')).toBe(false);
    await client(h.ep, token, 'claude-code');
    expect(h.screens.has('sh1')).toBe(true);
    expect(start).toHaveBeenCalledWith('sh1', 100, 30);
    await client(h.ep, token, 'codex-mcp-client');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a profile session still starts its screen model at spawn', async () => {
    const h = harness();
    await h.host.start();
    await launch(h, 's1');
    expect(h.screens.has('s1')).toBe(true);
  });

  it('a profile session respawned with no exit (a retired PTY) gets a fresh screen model', async () => {
    const h = harness();
    await h.host.start();
    await launch(h, 's1');
    h.output('s1', 'old child');
    expect((await h.screens.snapshot('s1'))?.lines[0]).toBe('old child');
    await launch(h, 's1');
    expect(h.screens.has('s1')).toBe(true);
    expect((await h.screens.snapshot('s1'))?.lines[0]).toBe('');
  });

  it('an exit whose token revoke fails is logged, not left unhandled', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    await h.host.start();
    await launch(h, 's1');
    vi.spyOn(h.tokens, 'revoke').mockRejectedValueOnce(new Error('store down'));
    h.exit('s1');
    await expect.poll(() => rec.of('token not revoked').length).toBe(1);
  });
});

describe('typed-command detection → notConnected (spec 2026-10-27-conduit-mcp-install §2.5, AC11)', () => {
  const shell = (h: Harness, id: string) => launch(h, id, SHELL, spec('/usr/bin/pwsh'));
  const notConnected = (h: Harness) => h.host.uiState().notConnected;
  async function typedAndWaited(h: Harness, id: string, line: string) {
    h.host.onRendererInput(id, line);
    h.clock.t += GRACE;
    await h.host.tick();
  }

  it('AC11 typed codex + no initialize within the grace → notConnected {cli: codex, install, reason: no-initialize}', async () => {
    const h = harness();
    await h.host.start();
    await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'codex\r');
    h.clock.t += GRACE - 1;
    await h.host.tick();
    expect(notConnected(h)).toEqual({});
    h.clock.t += 1;
    await h.host.tick();
    expect(notConnected(h)).toEqual({
      sh1: { cli: 'codex', install: 'not-installed', launch: 1, reason: 'no-initialize' },
    });
    await expect
      .poll(() =>
        h.broadcasts.some((b) => b.type === 'mcp:state' && b.state.notConnected.sh1 !== undefined),
      )
      .toBe(true);
  });

  it('AC11 detection runs before the store has loaded (tick before the notifier exists)', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const io = failingIo();
    io.fail = false;
    const slow: StoreIo = {
      ...io,
      readLog: async () => {
        await gate;
        return undefined;
      },
    };
    const h = harness({ storeIo: slow });
    const started = h.host.start();
    await expect
      .poll(() => {
        h.sessions.set('sh1', session('sh1', { agentId: 'pwsh' }));
        return h
          .prepareLaunch('sh1', SHELL, spec('/usr/bin/pwsh'))
          .then((out) => out.env?.CONDUIT_SESSION_TOKEN);
      })
      .toBeDefined();
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.cli).toBe('claude');
    release();
    await started;
  });

  it('AC11 initialize inside the grace → nothing; initialize after → cleared', async () => {
    const h = harness();
    await h.host.start();
    const a = await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, a.token, 'claude-code');
    h.clock.t += GRACE;
    await h.host.tick();
    expect(notConnected(h)).toEqual({});

    const b = await shell(h, 'sh2');
    await typedAndWaited(h, 'sh2', 'claude\r');
    expect(notConnected(h).sh2?.reason).toBe('no-initialize');
    await client(h.ep, b.token, 'claude-code');
    expect(notConnected(h)).toEqual({});
  });

  it('AC11 exit clears; relaunch clears and bumps launch', async () => {
    const h = harness();
    await h.host.start();
    await shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.launch).toBe(1);
    h.exit('sh1');
    expect(notConnected(h)).toEqual({});
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h)).toEqual({});

    await shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.launch).toBe(2);
    await shell(h, 'sh1');
    expect(notConnected(h)).toEqual({});
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.launch).toBe(3);
  });

  it('AC11 skip-list line is not a candidate', async () => {
    const h = harness();
    await h.host.start();
    await shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'codex --help\r');
    await typedAndWaited(h, 'sh1', 'claude mcp list\r');
    expect(notConnected(h)).toEqual({});
  });

  it('N2 focus reports and device-attribute replies mid-line are not typed input', async () => {
    const h = harness();
    await h.host.start();
    await shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'cod');
    h.host.onRendererInput('sh1', '\x1b[I');
    h.host.onRendererInput('sh1', '\x1b[?1;2c');
    h.host.onRendererInput('sh1', 'ex\x1b[O\r');
    h.clock.t += GRACE;
    await h.host.tick();
    expect(notConnected(h).sh1?.cli).toBe('codex');
  });

  it('adapter sessions never detect', async () => {
    const h = harness();
    await h.host.start();
    await launch(h, 's1');
    await launch(h, 'c1', CODEX, spec('/usr/bin/codex'));
    await typedAndWaited(h, 's1', 'codex\r');
    await typedAndWaited(h, 'c1', 'claude\r');
    expect(notConnected(h)).toEqual({});
  });

  it('a line typed while a CLI is live is ignored', async () => {
    const h = harness();
    await h.host.start();
    await client(h.ep, (await shell(h, 'sh1')).token, 'claude-code');
    await typedAndWaited(h, 'sh1', 'codex\r');
    expect(notConnected(h)).toEqual({});
  });

  it('messaging off → notConnected {}', async () => {
    let on = true;
    const h = harness({ messagingOn: () => on });
    await h.host.start();
    await shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(Object.keys(notConnected(h))).toEqual(['sh1']);
    on = false;
    expect(notConnected(h)).toEqual({});
  });

  it('cursor-not-connected profile launch → notConnected {cli: cursor, reason: cursor-not-connected}', async () => {
    const h = harness({ installState: (cli) => (cli === 'cursor' ? 'conflict' : 'not-installed') });
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    await h.prepareLaunch('c1', CURSOR, spec('/usr/bin/agent'));
    expect(notConnected(h)).toEqual({
      c1: { cli: 'cursor', install: 'conflict', launch: 1, reason: 'cursor-not-connected' },
    });
    // A Cursor client connecting cannot clear it: the session never got a token.
    h.exit('c1');
    expect(notConnected(h)).toEqual({});
  });

  it('onInstallChanged re-reads install state and broadcasts; only for the CLIs shown', async () => {
    const reads: string[] = [];
    let claude: 'not-installed' | 'installed' = 'not-installed';
    const h = harness({
      installState: (cli) => {
        reads.push(cli);
        return cli === 'claude' ? claude : 'not-installed';
      },
    });
    await h.host.start();
    await shell(h, 'sh1');
    await shell(h, 'sh2');
    await typedAndWaited(h, 'sh1', 'claude\r');
    await typedAndWaited(h, 'sh2', 'claude\r');
    reads.length = 0;
    claude = 'installed';
    const before = h.broadcasts.length;
    h.host.onInstallChanged();
    expect(reads).toEqual(['claude']);
    expect(notConnected(h).sh1?.install).toBe('installed');
    expect(notConnected(h).sh2?.install).toBe('installed');
    await expect.poll(() => h.broadcasts.length).toBeGreaterThan(before);
  });
});

/** Every line the endpoint sends, parsed; requests are fire-and-forget so a test can cancel them. */
async function rawClient(ep: string, token: string | null) {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(ep, () => resolve(s));
    s.on('error', reject);
  });
  sockets.push(sock);
  sock.setEncoding('utf8');
  const lines: Array<Record<string, unknown>> = [];
  let closed = false;
  sock.on('close', () => {
    closed = true;
  });
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
  });
  sock.write(`${JSON.stringify({ conduit: 1, token })}\n`);
  const send = (msg: Record<string, unknown>) =>
    sock.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const reply = (id: number | string) => until(() => lines.find((l) => l.id === id));
  const call = (id: number, name: string, args: unknown = {}) =>
    send({ id, method: 'tools/call', params: { name, arguments: args } });
  const cancel = (requestId: number) =>
    send({ method: 'notifications/cancelled', params: { requestId, reason: 'Esc' } });
  /** A ping's reply proves every earlier line was processed and answered (or not). */
  const barrier = async (id: number) => {
    send({ id, method: 'ping' });
    await reply(id);
  };
  const errorOf = (l: Record<string, unknown> | undefined) => {
    const r = l?.result as
      | { content: Array<{ text: string }>; structuredContent?: { error?: { code: string } } }
      | undefined;
    if (!r) return undefined;
    return (r.structuredContent ?? JSON.parse(r.content[0].text)).error?.code ?? 'ok';
  };
  return { sock, lines, send, reply, call, cancel, barrier, errorOf, isClosed: () => closed };
}

async function until<T>(f: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('policy gate, asks and cancellation (spec 2026-10-30-conduit-mcp-tool-policy §2.3–§2.4, §3.3)', () => {
  const asksOf = (h: Harness) =>
    h.toOwner.flatMap((s) => (s.msg.type === 'mcp:ask' ? [{ to: s.to, ...s.msg }] : []));
  const closedOf = (h: Harness) =>
    h.toOwner.flatMap((s) => (s.msg.type === 'mcp:askClosed' ? [s.msg] : []));
  const answer = (h: Harness, askId: string, a: 'approve' | 'deny' | 'always', senderId = 1) =>
    h.host.handleRenderer({ type: 'mcp:askAnswer', askId, answer: a }, () => undefined, senderId);
  const OPEN = { path: '/w', agent: 'e2e-fake-mcp' };
  /** The call's error code, or 'asked' when a card went out instead of a reply. */
  const replyOrAsk = async (h: Harness, c: Awaited<ReturnType<typeof rawClient>>, id: number) => {
    await until(() => c.lines.some((l) => l.id === id) || asksOf(h).length > 0);
    return asksOf(h).length > 0 ? 'asked' : c.errorOf(c.lines.find((l) => l.id === id));
  };
  const setPolicy = (h: Harness, layer: PolicyLayer | undefined) => {
    const s = h.sessions.get('s1');
    if (!s) throw new Error('no session s1');
    s.mcpToolPolicy = layer;
  };

  async function asking(over: Parameters<typeof harness>[0] = {}) {
    const h = harness({ kinds: { '/w': 'dir', '/w/a.ts': 'file' }, ...over });
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await rawClient(h.ep, a.token);
    return { h, c };
  }

  it('gate precedence', async () => {
    const { h, c } = await asking();
    h.presence.ready.delete(1);
    setPolicy(h, { open_terminal: { access: 'off' } });
    c.call(1, 'open_terminal', { path: '/w', command: 'node' });
    expect(c.errorOf(await c.reply(1))).toBe('tool_disabled');
    c.call(2, 'open_session', OPEN);
    expect(c.errorOf(await c.reply(2))).toBe('window_not_ready');
    h.presence.ready.add(1);
    h.presence.shown.set(1, new Set());
    c.call(3, 'open_session', OPEN);
    expect(c.errorOf(await c.reply(3))).toBe('caller_not_visible');
    h.owners.set('s1', null);
    c.call(4, 'open_file', { path: '/w/a.ts' });
    expect(c.errorOf(await c.reply(4))).toBe('window_not_ready');
    expect(h.toOwner).toEqual([]);
    expect([h.opens, h.files]).toEqual([[], []]);
    // when:always skips the on-screen step; messaging never reaches steps 4–5.
    h.owners.delete('s1');
    setPolicy(h, { open_file: { when: 'always' } });
    c.call(5, 'open_file', { path: '/w/a.ts' });
    expect(c.errorOf(await c.reply(5))).toBe('ok');
    h.presence.ready.delete(1);
    c.call(6, 'list_sessions');
    expect(c.errorOf(await c.reply(6))).toBe('ok');
  });

  it('on/viewing open_session runs with an unready owner or no owner window', async () => {
    for (const owner of ['unready', 'none'] as const) {
      const h = harness({ kinds: { '/w': 'dir' } });
      await h.host.start();
      const a = await launch(h, 's1');
      setPolicy(h, { open_session: { access: 'on' } });
      const c = await client(h.ep, a.token);
      if (owner === 'unready') h.presence.ready.delete(1);
      else h.owners.set('s1', null);

      const result = await c.call('open_session', OPEN);
      expect(result.isError).toBe(false);
      expect(result.body).toMatchObject({ session_id: 'n1' });
      expect(h.opens).toHaveLength(1);
      expect(h.toOwner.filter((entry) => entry.msg.type === 'mcp:ask')).toEqual([]);
      expect(h.toWindow.filter((entry) => entry.msg.type === 'mcp:ui')).toEqual([]);
    }
  });

  it('a bare command asks under an on policy, and the card names its path', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (candidate) => {
      if (candidate === '/usr/bin/kiro') return candidate;
      throw new Error(`unexpected realpath in this fixture: ${candidate}`);
    });
    const { h, c } = await asking({ kinds: { '/w': 'dir', '/usr/bin/kiro': 'file' } });
    try {
      setPolicy(h, { open_session: { access: 'on' } });
      c.call(1, 'open_session', { path: '/w', agent: 'kiro' });
      expect(await replyOrAsk(h, c, 1)).toBe('asked');
      expect(asksOf(h)[0]?.summary).toMatchObject({
        tool: 'open_session',
        command: '/usr/bin/kiro',
      });
      expect(h.opens).toEqual([]);
    } finally {
      realpath.mockRestore();
    }
  });

  it('a registered agent under an on policy opens without asking', async () => {
    const { h, c } = await asking();
    setPolicy(h, { open_session: { access: 'on' } });
    c.call(1, 'open_session', OPEN);
    expect(await replyOrAsk(h, c, 1)).toBe('ok');
    expect(asksOf(h)).toEqual([]);
  });

  it('a bare name that is an alias of a profile opens that profile, through the real registry', async () => {
    const registry = new AgentRegistry([FAKE, { ...CLAUDE, id: 'my-claude', label: 'My Claude' }], {
      'cli:claude': 'my-claude',
    });
    const h = harness({ kinds: { '/w': 'dir', '/w/wt': 'dir' }, registry });
    await h.host.start();
    const a = await launch(h, 's1');
    setPolicy(h, { open_session: { access: 'on' } });
    const c = await client(h.ep, a.token);
    const r = await c.call('open_session', { path: 'wt', agent: 'claude', focus: false });
    expect(r.isError).toBe(false);
    expect(h.opens[0]?.launch).toEqual({ kind: 'agent', agentId: 'my-claude' });
  });

  it('list_agents answers with the master switch off, every row none', async () => {
    let messaging = true;
    const h = harness({ messagingOn: () => messaging });
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    messaging = false;
    const r = await c.call('list_agents', {});
    expect(r.isError).toBe(false);
    const body = r.body as {
      agents: Array<{ id: string; messaging: string }>;
      bare_commands: boolean;
    };
    expect(body.bare_commands).toBe(true);
    expect(body.agents.map((x) => x.id)).toEqual(DEFS.map((d) => d.id));
    expect(body.agents.every((x) => x.messaging === 'none')).toBe(true);
  });

  it("the gate asks about the caller's own window, not any window", async () => {
    const { h, c } = await asking();
    h.presence.shown.set(1, new Set());
    h.presence.shown.set(2, new Set(['s1']));
    c.call(1, 'open_session', OPEN);
    expect(await replyOrAsk(h, c, 1)).toBe('caller_not_visible');
    h.presence.shown.clear();
    h.presence.ready.delete(1);
    c.call(2, 'open_session', OPEN);
    expect(await replyOrAsk(h, c, 2)).toBe('window_not_ready');
    expect(h.toOwner).toEqual([]);
  });

  it('a window reset during a held prepare → window_not_ready, no card', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered = false;
    const { h, c } = await asking({
      kindOf: async () => {
        entered = true;
        await held;
        return 'dir';
      },
    });
    c.call(1, 'open_session', OPEN);
    await until(() => entered);
    h.presence.ready.delete(1);
    h.host.onWindowReset(1);
    release();
    expect(await replyOrAsk(h, c, 1)).toBe('window_not_ready');
    expect(h.toOwner).toEqual([]);
    expect(h.host.uiState().awaitingApproval).toEqual([]);
  });

  it('session layer beats the CLI layer', async () => {
    const byCli: CliPolicyLayers = { agent: { open_file: { access: 'off' } } };
    const { h, c } = await asking({ toolPolicy: () => ({ global: DEFAULT_TOOL_POLICY, byCli }) });
    c.call(1, 'open_file', { path: '/w/a.ts' });
    expect(c.errorOf(await c.reply(1))).toBe('tool_disabled');
    setPolicy(h, { open_file: { access: 'on' } });
    c.call(2, 'open_file', { path: '/w/a.ts' });
    expect(c.errorOf(await c.reply(2))).toBe('ok');
  });

  it('ask end to end', async () => {
    const { h, c } = await asking();
    c.call(1, 'open_session', OPEN);
    const [ask] = await until(() => asksOf(h).length === 1 && asksOf(h));
    expect(ask).toMatchObject({
      to: 's1',
      type: 'mcp:ask',
      callerSessionId: 's1',
      callerHandle: 'fake-1',
      tool: 'open_session',
      summary: { tool: 'open_session', path: '/w', agent: 'e2e-fake-mcp', focus: true },
      args: OPEN,
      source: 'global',
    });
    expect(h.flashed).toEqual(['s1']);
    expect(h.host.uiState().awaitingApproval).toEqual(['s1']);
    await answer(h, ask.askId, 'approve');
    expect(c.errorOf(await c.reply(1))).toBe('ok');
    expect(h.opens).toHaveLength(1);
    expect(h.host.uiState().awaitingApproval).toEqual([]);
  });

  it('askAnswer from another window is ignored', async () => {
    const { h, c } = await asking();
    c.call(1, 'open_session', OPEN);
    const [ask] = await until(() => asksOf(h).length === 1 && asksOf(h));
    await answer(h, ask.askId, 'approve', 2);
    await c.barrier(2);
    expect(c.lines.some((l) => l.id === 1)).toBe(false);
    expect(h.opens).toEqual([]);
    await answer(h, ask.askId, 'approve', 1);
    expect(c.errorOf(await c.reply(1))).toBe('ok');
    expect(h.opens).toHaveLength(1);
  });

  it('a malformed askAnswer is dropped', async () => {
    const { h, c } = await asking();
    c.call(1, 'open_session', OPEN);
    const [ask] = await until(() => asksOf(h).length === 1 && asksOf(h));
    const forged: unknown = { type: 'mcp:askAnswer', askId: ask.askId, answer: 'yes' };
    await h.host.handleRenderer(forged as McpRendererMessage, () => undefined, 1);
    await c.barrier(2);
    expect(c.lines.some((l) => l.id === 1)).toBe(false);
  });

  it('notifications/cancelled → no reply line on any path', async () => {
    // A waiting ask.
    const one = await asking();
    one.c.call(1, 'open_session', OPEN);
    await until(() => asksOf(one.h).length === 1);
    one.c.cancel(1);
    await until(() => closedOf(one.h).length === 1);
    expect(closedOf(one.h)).toEqual([
      { type: 'mcp:askClosed', askId: 'ask-1', outcome: 'cancelled' },
    ]);
    await one.c.barrier(2);
    expect(one.c.lines.some((l) => l.id === 1)).toBe(false);
    expect(one.h.opens).toEqual([]);

    // An `on` call held in its path check.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered = false;
    const two = await asking({
      kindOf: async () => {
        entered = true;
        await held;
        return 'file';
      },
    });
    two.c.call(1, 'open_file', { path: '/w/a.ts' });
    await until(() => entered);
    two.c.cancel(1);
    await two.c.barrier(2);
    release();
    await two.c.barrier(3);
    expect(two.c.lines.some((l) => l.id === 1)).toBe(false);
    expect(two.h.files).toEqual([]);

    // A messaging call cancelled before its store write resolves.
    const io = failingIo();
    io.fail = false;
    let holdWrites = false;
    let writing = false;
    let wrote: () => void = () => undefined;
    const append = io.appendLog;
    io.appendLog = async (line) => {
      if (holdWrites) {
        writing = true;
        await new Promise<void>((r) => {
          wrote = r;
        });
      }
      return append(line);
    };
    const three = await asking({ storeIo: io });
    holdWrites = true;
    three.c.call(1, 'send_message', { to: ['you'], body: 'hi' });
    await until(() => writing);
    three.c.cancel(1);
    await three.c.barrier(2);
    wrote();
    await three.c.barrier(3);
    expect(three.c.lines.some((l) => l.id === 1)).toBe(false);
  });

  it('a cancel for another request id or another connection changes nothing', async () => {
    const { h, c } = await asking();
    const other = await rawClient(h.ep, null);
    c.call(1, 'open_session', OPEN);
    await until(() => asksOf(h).length === 1);
    c.cancel(9);
    other.cancel(1);
    await c.barrier(2);
    await other.barrier(3);
    expect(closedOf(h)).toEqual([]);
    await answer(h, 'ask-1', 'approve');
    expect(c.errorOf(await c.reply(1))).toBe('ok');
  });

  it('connection close / onWindowReset(1) / onSessionMoved / onSessionDeleted cancel', async () => {
    const closing = await asking();
    closing.c.call(1, 'open_session', OPEN);
    await until(() => asksOf(closing.h).length === 1);
    closing.c.sock.destroy();
    await until(() => closedOf(closing.h).length === 1);
    expect(closing.h.host.uiState().awaitingApproval).toEqual([]);

    const ends: Array<(h: Harness) => void> = [
      (h) => h.host.onWindowReset(1),
      (h) => h.host.onSessionMoved('s1'),
      (h) => void h.host.onSessionDeleted('s1'),
    ];
    for (const end of ends) {
      const { h, c } = await asking();
      c.call(1, 'open_session', OPEN);
      await until(() => asksOf(h).length === 1);
      end(h);
      expect(c.errorOf(await c.reply(1))).toBe('cancelled');
      expect(closedOf(h)).toEqual([
        { type: 'mcp:askClosed', askId: 'ask-1', outcome: 'cancelled' },
      ]);
      expect(h.opens).toEqual([]);
    }
  });

  it('onSessionDeleted answers the waiting ask, then closes the connection', async () => {
    const { h, c } = await asking();
    c.call(1, 'open_session', OPEN);
    await until(() => asksOf(h).length === 1);
    await h.host.onSessionDeleted('s1');
    await until(() => c.isClosed());
    expect(c.errorOf(c.lines.find((l) => l.id === 1))).toBe('cancelled');
  });

  it('onSessionDeleted releases the screen and token before it first yields', async () => {
    const { h } = await asking();
    if (!h.screens.has('s1')) h.screens.start('s1', 40, 24);
    expect(h.tokens.rows()).toMatchObject({ rows: [{ sessionId: 's1' }] });
    const deleted = h.host.onSessionDeleted('s1');
    expect(h.screens.has('s1')).toBe(false);
    expect(h.tokens.rows()).toMatchObject({ state: 'loaded', rows: [] });
    await deleted;
  });

  it('onSessionDeleted answers every waiting ask before it closes', async () => {
    const { h, c } = await asking();
    for (const id of [1, 2, 3]) c.call(id, 'open_session', OPEN);
    await until(() => asksOf(h).length === 3);
    await h.host.onSessionDeleted('s1');
    await until(() => c.isClosed());
    expect([1, 2, 3].map((id) => c.errorOf(c.lines.find((l) => l.id === id)))).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('onWindowReset of another window leaves the ask waiting', async () => {
    const { h, c } = await asking();
    c.call(1, 'open_session', OPEN);
    await until(() => asksOf(h).length === 1);
    h.host.onWindowReset(2);
    h.host.onSessionMoved('s9');
    await c.barrier(2);
    expect(closedOf(h)).toEqual([]);
  });

  it('refresh after access → off cancels the waiting ask', async () => {
    let global: GlobalPolicy = DEFAULT_TOOL_POLICY;
    const { h, c } = await asking({ toolPolicy: () => ({ global, byCli: {} }) });
    c.call(1, 'open_session', OPEN);
    await until(() => asksOf(h).length === 1);
    h.host.refresh();
    await c.barrier(2);
    expect(closedOf(h)).toEqual([]);
    global = { ...global, open_session: { ...global.open_session, access: 'off' } };
    h.host.refresh();
    expect(c.errorOf(await c.reply(1))).toBe('cancelled');
  });

  it("a waiting ask doesn't block another call on the same connection", async () => {
    const { h, c } = await asking();
    c.call(1, 'open_session', OPEN);
    await until(() => asksOf(h).length === 1);
    c.call(2, 'list_sessions');
    expect(c.errorOf(await c.reply(2))).toBe('ok');
    c.call(3, 'open_file', { path: '/w/a.ts' });
    expect(c.errorOf(await c.reply(3))).toBe('ok');
    expect(c.lines.some((l) => l.id === 1)).toBe(false);
  });

  it('uiState.awaitingApproval lists the waiting caller', async () => {
    const { h, c } = await asking();
    expect(h.host.uiState().awaitingApproval).toEqual([]);
    c.call(1, 'open_session', OPEN);
    c.call(2, 'open_session', OPEN);
    await until(() => asksOf(h).length === 2);
    expect(h.host.uiState().awaitingApproval).toEqual(['s1']);
    await answer(h, 'ask-1', 'deny');
    expect(c.errorOf(await c.reply(1))).toBe('denied');
    expect(h.host.uiState().awaitingApproval).toEqual(['s1']);
    await answer(h, 'ask-2', 'always');
    expect(c.errorOf(await c.reply(2))).toBe('ok');
    expect(h.sessions.get('s1')?.mcpToolPolicy).toEqual({ open_session: { access: 'on' } });
    expect(h.host.uiState().awaitingApproval).toEqual([]);
    c.call(3, 'open_session', OPEN);
    expect(c.errorOf(await c.reply(3))).toBe('ok');
    expect(asksOf(h)).toHaveLength(2);
  });

  it('mcp:setToolPolicy replies unknown-session / unknown-tool / invalid-value / ok', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await client(h.ep, a.token);
    await c.listed();
    const set = async (m: { sessionId: string; tool: string; patch: unknown }) => {
      const replies: HostToWebview[] = [];
      const msg: unknown = { type: 'mcp:setToolPolicy', requestId: 9, ...m };
      await h.host.handleRenderer(msg as McpRendererMessage, (r) => replies.push(r), 1);
      return replies;
    };
    const refused = (error: string) => [
      { type: 'mcp:toolPolicyResult', requestId: 9, ok: false, error },
    ];
    expect(await set({ sessionId: 'nope', tool: 'open_file', patch: { access: 'on' } })).toEqual(
      refused('unknown-session'),
    );
    expect(await set({ sessionId: 's1', tool: 'rm_rf', patch: { access: 'on' } })).toEqual(
      refused('unknown-tool'),
    );
    for (const patch of [{ access: 'yes' }, { move: 'no' }, {}, 'inherit', null])
      expect(await set({ sessionId: 's1', tool: 'open_file', patch })).toEqual(
        refused('invalid-value'),
      );
    expect(h.sessions.get('s1')?.mcpToolPolicy).toBeUndefined();
    expect(c.notifications).toEqual([]);
    expect(
      await set({ sessionId: 's1', tool: 'open_terminal', patch: { access: 'ask', move: 'no' } }),
    ).toEqual([{ type: 'mcp:toolPolicyResult', requestId: 9, ok: true }]);
    expect(h.sessions.get('s1')?.mcpToolPolicy).toEqual({
      open_terminal: { access: 'ask', move: 'no' },
    });
    await until(() => c.notifications.length === 1);
    expect(c.notifications).toEqual(['notifications/tools/list_changed']);
  });
});

describe('app-control tools at the host (spec 2026-10-30-conduit-mcp-app-control §2.3)', () => {
  type UiMsg = Extract<HostToWebview, { type: 'mcp:ui' }>;
  const uiOf = (h: Harness) =>
    h.toWindow.flatMap((s) =>
      s.msg.type === 'mcp:ui' ? [{ windowId: s.windowId, ...s.msg }] : [],
    );
  const lastUi = async (h: Harness, n = 1): Promise<UiMsg & { windowId: number }> => {
    const all = await until(() => uiOf(h).length >= n && uiOf(h));
    return all[n - 1];
  };
  const uiResult = (h: Harness, requestId: string, result: unknown, senderId: number) =>
    h.host.handleRenderer({ type: 'mcp:uiResult', requestId, result }, () => undefined, senderId);
  const resultOf = (l: Record<string, unknown> | undefined) => {
    const r = l?.result as
      | { content: Array<{ text: string }>; structuredContent?: unknown }
      | undefined;
    return r ? (r.structuredContent ?? JSON.parse(r.content[0].text)) : undefined;
  };
  const allow = (h: Harness, id: string, layer: PolicyLayer) => {
    const s = h.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    s.mcpToolPolicy = layer;
  };

  /** s1 calls; s2 is a listed peer (window 2 unless told otherwise); both have handles. */
  async function twoSessions(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    await h.host.start();
    const a = await launch(h, 's1');
    const c = await rawClient(h.ep, a.token);
    const b = await launch(h, 's2');
    const peer = await client(h.ep, b.token);
    await peer.listed();
    h.owners.set('s2', 2);
    return { h, c };
  }

  it('targets are listed sessions only', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { close_session: { access: 'on', reach: 'any' } });
    h.sessions.set('s3', session('s3'));
    c.call(1, 'close_session', { session: 's3' });
    expect(c.errorOf(await c.reply(1))).toBe('unknown_session');
    expect(uiOf(h)).toEqual([]);
  });

  it('close_session end to end', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { close_session: { access: 'on', reach: 'any' } });
    const handle = h.sessions.get('s2')?.mcpHandle;
    c.call(1, 'close_session', { session: handle });
    const ui = await lastUi(h);
    expect(ui).toEqual({
      windowId: 2,
      type: 'mcp:ui',
      requestId: ui.requestId,
      sessionId: 's1',
      action: { kind: 'closeSession', target: 's2' },
    });
    await uiResult(h, ui.requestId, { kind: 'closeSession', ok: true }, 2);
    expect(resultOf(await c.reply(1))).toEqual({ closed: 's2' });
  });

  it('close_session without a ready owner uses the domain close and does not post renderer UI', async () => {
    const h = harness();
    await h.host.start();
    const a = await launch(h, 's1');
    const b = await launch(h, 's2');
    const c = await rawClient(h.ep, a.token);
    const peer = await client(h.ep, b.token);
    await peer.listed();
    h.owners.set('s2', null);
    const caller = h.sessions.get('s1');
    if (!caller) throw new Error('no session s1');
    caller.mcpToolPolicy = { close_session: { access: 'on', reach: 'any' } };

    c.call(1, 'close_session', { session: h.sessions.get('s2')?.mcpHandle });
    expect(c.errorOf(await c.reply(1))).toBe('ok');
    expect(resultOf(c.lines.find((line) => line.id === 1))).toEqual({ closed: 's2' });
    expect(h.closes).toEqual(['s2']);
    expect(h.toWindow.filter((entry) => entry.msg.type === 'mcp:ui')).toEqual([]);
  });

  it('closeWhenDone with a ready owner asks its window to close and closes on the answer', async () => {
    const { h } = await twoSessions();
    const closing = h.host.closeWhenDone('s2');
    const ui = await lastUi(h);
    expect(ui.action).toEqual({ kind: 'closeSession', target: 's2' });
    expect(h.closes).toEqual([]);
    await uiResult(h, ui.requestId, { kind: 'closeSession', ok: true }, 2);
    await closing;
    // The renderer removes the session on its own close; the domain is not called directly.
    expect(h.closes).toEqual([]);
  });

  it('closeWhenDone keeps the exited session when its window finds unsaved changes', async () => {
    const { h } = await twoSessions();
    const closing = h.host.closeWhenDone('s2');
    const ui = await lastUi(h);
    await uiResult(h, ui.requestId, { kind: 'closeSession', ok: false, unsaved: ['a.ts'] }, 2);
    await closing;
    expect(h.closes).toEqual([]);
  });

  it('closeWhenDone without a ready owner closes through the domain and posts no UI', async () => {
    const { h } = await twoSessions();
    h.owners.set('s2', null);
    await h.host.closeWhenDone('s2');
    expect(h.closes).toEqual(['s2']);
    expect(uiOf(h)).toEqual([]);
  });

  it('closeWhenDone whose window times out leaves the exited session open and logs it', async () => {
    const rec = recordingLog();
    const { h } = await twoSessions({ manualTimers: true, log: rec.log });
    const closing = h.host.closeWhenDone('s2');
    await lastUi(h);
    h.advance(5_000);
    await closing;
    expect(h.closes).toEqual([]);
    expect(h.sessions.has('s2')).toBe(true);
    expect(rec.of('closeWhenDone kept open').map((e) => e.data)).toEqual([
      { sessionId: 's2', code: 'ui_timeout' },
    ]);
  });

  it('closeWhenDone whose window does not know the session closes it through the domain', async () => {
    const rec = recordingLog();
    const { h } = await twoSessions({ log: rec.log });
    const closing = h.host.closeWhenDone('s2');
    const ui = await lastUi(h);
    await uiResult(h, ui.requestId, { kind: 'unknownSession' }, 2);
    await closing;
    expect(h.closes).toEqual(['s2']);
    expect(rec.of('control app').map((e) => e.data)).toContainEqual(
      expect.objectContaining({
        tool: 'closeWhenDone',
        sessionId: 's2',
        fallback: 'unknownSession',
      }),
    );
    expect(rec.of('closeWhenDone kept open')).toEqual([]);
  });

  it('closeWhenDone whose session is deleted mid-wait is logged closed, with no domain close', async () => {
    const rec = recordingLog();
    const { h } = await twoSessions({ log: rec.log });
    const closing = h.host.closeWhenDone('s2');
    await lastUi(h);
    h.sessions.delete('s2');
    await h.host.onSessionDeleted('s2');
    await closing;
    expect(h.closes).toEqual([]);
    expect(rec.of('closeWhenDone kept open')).toEqual([]);
    expect(rec.of('closeWhenDone closed').map((e) => e.data)).toEqual([{ sessionId: 's2' }]);
  });

  it('a terminal an agent opened stays listed after it exits, and its opener can close it (CON-149)', async () => {
    const h = harness({ kinds: { '/w': 'dir' } });
    await h.host.start();
    const a = await launch(h, 's1');
    allow(h, 's1', {
      open_terminal: { access: 'on' },
      close_session: { access: 'on', reach: 'opened' },
    });
    const c = await rawClient(h.ep, a.token);
    c.call(1, 'open_terminal', { path: '/w', command: 'node' });
    expect(resultOf(await c.reply(1))).toMatchObject({ session_id: 'n1', handle: 'term-1' });
    h.owners.set('n1', null);
    h.exit('n1');
    c.call(2, 'list_sessions');
    const listed = resultOf(await c.reply(2)) as {
      sessions: Array<{ handle: string; presence: string }>;
    };
    expect(listed.sessions).toContainEqual(
      expect.objectContaining({ handle: 'term-1', presence: 'exited' }),
    );
    c.call(3, 'close_session', { session: 'term-1' });
    expect(c.errorOf(await c.reply(3))).toBe('ok');
    expect(h.closes).toEqual(['n1']);
  });

  it('self close: the reply is written before the drained connection closes', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { close_session: { access: 'on' } });
    c.call(1, 'close_session', { session: 's1' });
    const ui = await lastUi(h);
    expect(ui.windowId).toBe(1);
    // As the renderer does: the answer, then the kill, in separate tasks.
    await new Promise<void>((r) =>
      setTimeout(() => {
        void uiResult(h, ui.requestId, { kind: 'closeSession', ok: true }, 1);
        setTimeout(() => {
          void h.host.onSessionDeleted('s1').then(() => r());
        }, 0);
      }, 0),
    );
    await until(() => c.isClosed());
    expect(resultOf(c.lines.find((l) => l.id === 1))).toEqual({ closed: 's1' });
  });

  it('uiResult from a different window is ignored', async () => {
    const { h, c } = await twoSessions({ manualTimers: true });
    allow(h, 's1', { open_url: { access: 'on' } });
    c.call(1, 'open_url', { url: 'http://x/' });
    const ui = await lastUi(h);
    expect(ui.windowId).toBe(1);
    await uiResult(h, ui.requestId, { kind: 'opened' }, 2);
    await c.barrier(2);
    expect(c.lines.some((l) => l.id === 1)).toBe(false);
    h.advance(5_000);
    expect(c.errorOf(await c.reply(1))).toBe('ui_timeout');
  });

  it('onWindowReset during a UI wait → window_not_ready', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { open_url: { access: 'on' } });
    c.call(1, 'open_url', { url: 'http://x/' });
    await lastUi(h);
    h.host.onWindowReset(1);
    expect(c.errorOf(await c.reply(1))).toBe('window_not_ready');
  });

  it('onSessionMoved(target) during a close_session wait → window_not_ready', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { close_session: { access: 'on', reach: 'any' } });
    c.call(1, 'close_session', { session: h.sessions.get('s2')?.mcpHandle });
    await lastUi(h);
    h.host.onSessionMoved('s2');
    expect(c.errorOf(await c.reply(1))).toBe('window_not_ready');
  });

  it('notifications/cancelled during a UI wait → no reply line', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { open_url: { access: 'on' } });
    c.call(1, 'open_url', { url: 'http://x/' });
    const ui = await lastUi(h);
    c.cancel(1);
    await c.barrier(2);
    // Answered after the cancel: the wait is gone, so nothing reaches the CLI.
    await uiResult(h, ui.requestId, { kind: 'opened' }, 1);
    await c.barrier(3);
    expect(c.lines.map((l) => l.id)).toEqual([2, 3]);
  });

  it('reach refusal at the host', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { close_session: { access: 'on', reach: 'self' } });
    c.call(1, 'close_session', { session: h.sessions.get('s2')?.mcpHandle });
    expect(c.errorOf(await c.reply(1))).toBe('out_of_reach');
    expect(uiOf(h)).toEqual([]);
  });

  it('an ask for a UI tool expires 5 s early', async () => {
    const { h, c } = await twoSessions({ manualTimers: true });
    allow(h, 's1', { open_url: { access: 'ask' } });
    c.call(1, 'open_url', { url: 'http://x/' });
    await until(() => h.toOwner.some((m) => m.msg.type === 'mcp:ask'));
    h.advance(20_000 - 1);
    await c.barrier(2);
    expect(c.lines.some((l) => l.id === 1)).toBe(false);
    h.advance(1);
    expect(c.errorOf(await c.reply(1))).toBe('approval_timeout');
    expect(uiOf(h)).toEqual([]);
  });

  it('a launch-wired codex ask waits 170 s less the UI step (single-gate spec)', async () => {
    const h = harness({ manualTimers: true });
    await h.host.start();
    const a = await launch(h, 's3', CODEX, spec('/usr/bin/codex'));
    expect(a.spec.args).toContain('mcp_servers.conduit.tool_timeout_sec=180');
    const c = await rawClient(h.ep, a.token);
    allow(h, 's3', { open_url: { access: 'ask' } });
    c.call(1, 'open_url', { url: 'http://x/' });
    await until(() => h.toOwner.some((m) => m.msg.type === 'mcp:ask'));
    h.advance(165_000 - 1);
    await c.barrier(2);
    expect(c.lines.some((l) => l.id === 1)).toBe(false);
    h.advance(1);
    expect(c.errorOf(await c.reply(1))).toBe('approval_timeout');
  });

  it('read_screen refuses the caller as its own target', async () => {
    const { h, c } = await twoSessions();
    c.call(1, 'read_screen', { session: h.sessions.get('s1')?.mcpHandle });
    expect(c.errorOf(await c.reply(1))).toBe('self_target');
  });

  it('reads trimmed last rows and relative cursor from the helper screen', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { read_screen: { access: 'on', reach: 'any' } });
    h.output('s2', 'first\r\nsecond\r\nthird');
    c.call(1, 'read_screen', { session: 's2', lines: 2 });
    expect(resultOf(await c.reply(1))).toMatchObject({
      rows: ['second', 'third'],
      cursor_row: 1,
      cols: 40,
      presence: 'idle',
    });
    h.busy.add('s2');
    c.call(2, 'read_screen', { session: 's2' });
    expect(resultOf(await c.reply(2))).toMatchObject({ presence: 'busy' });
  });

  it('sends text, keys and a separate submit in order', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    c.call(1, 'send_input', {
      session: 's2',
      text: 'hello',
      keys: ['tab', 'ctrl+c'],
      submit: true,
    });
    expect(resultOf(await c.reply(1))).toMatchObject({ sent_chars: 5, keys_sent: 2 });
    expect(h.inputs.filter(([id]) => id === 's2')).toEqual([
      ['s2', 'hello'],
      ['s2', '\t\x03'],
      ['s2', '\r'],
    ]);
  });

  it('rejects unsafe input before typing', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    c.call(1, 'send_input', { session: 's2', text: 'a\nb' });
    expect(c.errorOf(await c.reply(1))).toBe('invalid_args');
    expect(h.inputs.filter(([id]) => id === 's2')).toEqual([]);
  });
  it('uses bracketed paste and rejects all control characters', async () => {
    const { h, c } = await twoSessions({ bracketedPaste: () => true });
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    c.call(1, 'send_input', { session: 's2', text: 'a\nb' });
    expect(resultOf(await c.reply(1))).toMatchObject({ sent_chars: 3 });
    expect(h.inputs).toContainEqual(['s2', '\x1b[200~a\nb\x1b[201~']);
    for (const [i, text] of ['\x00', '\x1b[200~', '\x7f', '\x85'].entries()) {
      c.call(i + 2, 'send_input', { session: 's2', text });
      expect(c.errorOf(await c.reply(i + 2))).toBe('invalid_args');
    }
  });

  it('reports target and input errors without writing', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', {
      send_input: { access: 'on', reach: 'opened' },
      read_screen: { access: 'on', reach: 'opened' },
    });
    c.call(1, 'read_screen', { session: 'missing' });
    expect(resultOf(await c.reply(1))).toMatchObject({
      error: {
        code: 'unknown_session',
        hint: expect.stringContaining('list_sessions'),
        valid: [h.sessions.get('s1')?.mcpHandle],
      },
    });
    c.call(2, 'read_screen', { session: 's2' });
    expect(resultOf(await c.reply(2))).toMatchObject({
      error: { code: 'out_of_reach', hint: expect.stringContaining('Settings') },
    });
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    c.call(3, 'send_input', { session: 's2' });
    expect(c.errorOf(await c.reply(3))).toBe('invalid_args');
    h.exit('s2');
    c.call(4, 'send_input', { session: 's2', text: 'x' });
    expect(c.errorOf(await c.reply(4))).toBe('session_exited');
    expect(h.inputs.filter(([id]) => id === 's2')).toEqual([]);
  });

  it('reports a failed submit as restarting', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    h.failEnter.add('s2');
    c.call(1, 'send_input', { session: 's2', text: 'x', submit: true });
    expect(c.errorOf(await c.reply(1))).toBe('session_restarting');
  });
  it('maps every supported key and validates input limits', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    c.call(1, 'send_input', {
      session: 's2',
      keys: ['enter', 'tab', 'esc', 'backspace', 'space', 'ctrl+c'],
    });
    expect(resultOf(await c.reply(1))).toMatchObject({ sent_chars: 0, keys_sent: 6 });
    expect(h.inputs).toContainEqual(['s2', '\r\t\x1b\x7f \x03']);
    for (const [i, args] of [
      { text: 'x'.repeat(4001) },
      { keys: Array(21).fill('tab') },
      { keys: ['bad'] },
      { submit: true },
    ].entries()) {
      c.call(i + 2, 'send_input', { session: 's2', ...args });
      expect(c.errorOf(await c.reply(i + 2))).toBe('invalid_args');
    }
  });

  it('returns empty rows without a snapshot and null cursor outside the requested rows', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { read_screen: { access: 'on', reach: 'any' } });
    h.screens.dispose('s2');
    c.call(1, 'read_screen', { session: 's2' });
    expect(resultOf(await c.reply(1))).toMatchObject({ rows: [], cursor_row: null, cols: 40 });
    h.screens.start('s2', 40, 10);
    h.output('s2', 'first\r\nsecond\r\nthird\x1b[2A');
    c.call(2, 'read_screen', { session: 's2', lines: 1 });
    expect(resultOf(await c.reply(2))).toMatchObject({ rows: ['third'], cursor_row: null });
    for (const [i, lines] of [0, 201, 1.5].entries()) {
      c.call(i + 3, 'read_screen', { session: 's2', lines });
      expect(c.errorOf(await c.reply(i + 3))).toBe('invalid_args');
    }
  });

  it('rechecks paste mode after approval and shows the full request', async () => {
    let paste = true;
    const { h, c } = await twoSessions({ bracketedPaste: () => paste });
    allow(h, 's1', { send_input: { access: 'ask', reach: 'any' } });
    c.call(1, 'send_input', { session: 's2', text: 'first\nsecond', keys: ['ctrl+c'] });
    await until(() => h.toOwner.some(({ msg }) => msg.type === 'mcp:ask'));
    const ask = h.toOwner.find(({ msg }) => msg.type === 'mcp:ask')?.msg;
    if (ask?.type !== 'mcp:ask') throw new Error('missing ask');
    expect(ask.summary).toMatchObject({
      tool: 'send_input',
      text: 'first\nsecond',
      keys: ['ctrl+c'],
    });
    paste = false;
    await h.host.handleRenderer(
      { type: 'mcp:askAnswer', askId: ask.askId, answer: 'approve' },
      () => undefined,
      1,
    );
    expect(c.errorOf(await c.reply(1))).toBe('invalid_args');
    expect(h.inputs.filter(([id]) => id === 's2')).toEqual([]);
  });
  it('reports a refused write as restarting', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    h.alive.delete('s2');
    c.call(1, 'send_input', { session: 's2', text: 'x' });
    expect(c.errorOf(await c.reply(1))).toBe('session_restarting');
  });

  it('rechecks reach and exit while approval is pending', async () => {
    const { h, c } = await twoSessions();
    h.owners.set('s2', 1);
    allow(h, 's1', { send_input: { access: 'ask', reach: 'window' } });
    c.call(1, 'send_input', { session: 's2', text: 'x' });
    await until(() => h.toOwner.some(({ msg }) => msg.type === 'mcp:ask'));
    const first = h.toOwner.find(({ msg }) => msg.type === 'mcp:ask')?.msg;
    if (first?.type !== 'mcp:ask') throw new Error('missing ask');
    h.owners.set('s2', 2);
    await h.host.handleRenderer(
      { type: 'mcp:askAnswer', askId: first.askId, answer: 'approve' },
      () => undefined,
      1,
    );
    expect(c.errorOf(await c.reply(1))).toBe('out_of_reach');
    h.owners.set('s2', 1);
    c.call(2, 'send_input', { session: 's2', text: 'x' });
    await until(() => h.toOwner.filter(({ msg }) => msg.type === 'mcp:ask').length === 2);
    const second = h.toOwner.filter(({ msg }) => msg.type === 'mcp:ask')[1]?.msg;
    if (second?.type !== 'mcp:ask') throw new Error('missing ask');
    h.exit('s2');
    await h.host.handleRenderer(
      { type: 'mcp:askAnswer', askId: second.askId, answer: 'approve' },
      () => undefined,
      1,
    );
    expect(c.errorOf(await c.reply(2))).toBe('session_exited');
    expect(h.inputs.filter(([id]) => id === 's2')).toEqual([]);
  });
  it('reads a helper launched while messaging was off through its real lifecycle', async () => {
    let messaging = true;
    const h = harness({ messagingOn: () => messaging });
    await h.host.start();
    const caller = await launch(h, 's1');
    const c = await rawClient(h.ep, caller.token);
    messaging = false;
    h.sessions.set(
      's2',
      session('s2', {
        agentId: SHELL.id,
        mcpHandle: 'term-1',
        openedBy: { handle: 'fake-1', sessionId: 's1' },
      }),
    );
    await launch(h, 's2', SHELL);
    h.output('s2', 'unregistered helper screen');
    messaging = true;
    allow(h, 's1', { read_screen: { access: 'on', reach: 'opened' } });
    c.call(1, 'read_screen', { session: 's2' });
    expect(resultOf(await c.reply(1))).toMatchObject({ rows: ['unregistered helper screen'] });
  });
  it('marks typed helper input as a draft for the notice gate', async () => {
    const { h, c } = await twoSessions();
    h.output('s2', 'fake❯ ');
    h.clock.t += 10000;
    allow(h, 's1', { send_input: { access: 'on', reach: 'any' } });
    c.call(1, 'send_input', { session: 's2', text: 'draft' });
    expect(resultOf(await c.reply(1))).toMatchObject({ sent_chars: 5 });
    await h.host.tick();
    expect(h.host.uiState().sessions.s2?.gate).toBe('draft');
  });
  it('focus_session and attach_folder run host-side', async () => {
    const { h, c } = await twoSessions();
    allow(h, 's1', {
      focus_session: { access: 'on', reach: 'any' },
      attach_folder: { access: 'on' },
    });
    c.call(1, 'focus_session', { session: h.sessions.get('s2')?.mcpHandle });
    expect(resultOf(await c.reply(1))).toEqual({ focused: 's2' });
    expect(h.activations).toEqual([{ id: 's2', raise: true }]);
    c.call(2, 'attach_folder', { path: 'sub' });
    expect(resultOf(await c.reply(2))).toEqual({
      attached: '/w/sub',
      session_id: 's1',
      roots: ['/w/sub'],
    });
    expect(uiOf(h)).toEqual([]);
  });
});

describe('createConduitMcpHost — wait_sessions', () => {
  /** s1 is the caller (fake-1), s2 the helper (fake-2); the caller's client is connected. */
  async function pairForWait(h: Harness) {
    await h.host.start();
    const a = await launch(h, 's1');
    const b = await launch(h, 's2');
    const ca = await client(h.ep, a.token);
    return { ca, s2Token: b.token };
  }

  /** Writes a tools/call with a chosen id, so a test can cancel it by that id. */
  function rawWait(c: Awaited<ReturnType<typeof client>>, id: number, args: unknown) {
    c.sock.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'wait_sessions', arguments: args } })}\n`,
    );
  }

  it('wait_sessions is listed with its input schema', async () => {
    const h = harness();
    const { ca } = await pairForWait(h);
    const list = (await ca.request('tools/list')) as {
      result: {
        tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
      };
    };
    const tool = list.result.tools.find((t) => t.name === 'wait_sessions');
    expect(tool && Object.keys(tool.inputSchema.properties).sort()).toEqual([
      'sessions',
      'timeout_s',
      'until',
    ]);
  });

  it('a session that already exited returns at once', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    h.exit('s2');
    const r = await ca.call('wait_sessions', { sessions: ['fake-2'], until: ['exited'] });
    expect(r.isError).toBe(false);
    // The default 120 s is over an unknown caller's trimmed 20 s, so it reports the clamp too.
    expect(r.body).toEqual({
      fired: [{ session: 'fake-2', condition: 'exited' }],
      timed_out: false,
      states: [{ session: 'fake-2', presence: 'exited', needs_you: false, unread_from: 0 }],
      clamped_to: 20,
    });
  });

  it('exited fires when the session exits during the wait', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', { sessions: ['fake-2'], until: ['exited'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    h.exit('s2');
    expect((await p).body.fired).toEqual([{ session: 'fake-2', condition: 'exited' }]);
  });

  it('turn_end fires when a busy session finishes its turn after the call started', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    h.busy.add('s2');
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', { sessions: ['fake-2'], until: ['turn_end'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    h.finishTurn('s2');
    expect((await p).body).toEqual({
      fired: [{ session: 'fake-2', condition: 'turn_end' }],
      timed_out: false,
      states: [{ session: 'fake-2', presence: 'idle', needs_you: false, unread_from: 0 }],
      clamped_to: 20,
    });
  });

  it('a turn end that finished before the first wait is reported by it', async () => {
    const h = harness();
    const { ca } = await pairForWait(h);
    h.busy.add('s2');
    h.finishTurn('s2');
    const r = await ca.call('wait_sessions', { sessions: ['fake-2'], until: ['turn_end'] });
    expect(r.body.fired).toEqual([{ session: 'fake-2', condition: 'turn_end' }]);
  });

  it('a turn end that landed between two waits is reported by the second', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    h.busy.add('s2');
    const base = h.pendingTimers;
    const first = ca.call('wait_sessions', { sessions: ['fake-2'], until: ['turn_end'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    h.finishTurn('s2');
    expect((await first).body.fired).toEqual([{ session: 'fake-2', condition: 'turn_end' }]);
    h.busy.add('s2');
    h.finishTurn('s2');
    const second = await ca.call('wait_sessions', { sessions: ['fake-2'], until: ['turn_end'] });
    expect(second.body.fired).toEqual([{ session: 'fake-2', condition: 'turn_end' }]);
  });

  it('message fires on an unread message from a listed session, not from another', async () => {
    const h = harness({ manualTimers: true });
    await h.host.start();
    const a = await launch(h, 's1');
    const s2 = await launch(h, 's2');
    const s3 = await launch(h, 's3');
    const ca = await client(h.ep, a.token);
    const c2 = await client(h.ep, s2.token);
    const c3 = await client(h.ep, s3.token);
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', { sessions: ['fake-2'], until: ['message'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    await c3.call('send_message', { to: ['fake-1'], body: 'from three' });
    expect(h.pendingTimers).toBe(base + 1);
    await c2.call('send_message', { to: ['fake-1'], body: 'from two' });
    expect((await p).body).toEqual({
      fired: [{ session: 'fake-2', condition: 'message' }],
      timed_out: false,
      states: [{ session: 'fake-2', presence: 'idle', needs_you: false, unread_from: 1 }],
      clamped_to: 20,
    });
  });

  it('needs_you fires when the session needs the human', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', { sessions: ['fake-2'], until: ['needs_you'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    h.setNeedsYou('s2', true);
    expect((await p).body).toEqual({
      fired: [{ session: 'fake-2', condition: 'needs_you' }],
      timed_out: false,
      states: [{ session: 'fake-2', presence: 'idle', needs_you: true, unread_from: 0 }],
      clamped_to: 20,
    });
  });

  it('times out with nothing fired and every requested session in states', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', {
      sessions: ['fake-2'],
      until: ['turn_end', 'exited'],
      timeout_s: 5,
    });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    h.advance(5_000);
    expect((await p).body).toEqual({
      fired: [],
      timed_out: true,
      states: [{ session: 'fake-2', presence: 'idle', needs_you: false, unread_from: 0 }],
    });
    expect(h.pendingTimers).toBe(base);
  });

  it('a client cancel releases the wait and its timer without a reply', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    rawWait(ca, 900, { sessions: ['fake-2'], until: ['exited'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    ca.sock.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 900 } })}\n`,
    );
    await expect.poll(() => h.pendingTimers).toBe(base);
  });

  it('closing the caller connection releases the wait and its timer', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    rawWait(ca, 901, { sessions: ['fake-2'], until: ['exited'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    ca.sock.destroy();
    await expect.poll(() => h.pendingTimers).toBe(base);
  });

  it('deleting the caller session releases its waits', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    rawWait(ca, 902, { sessions: ['fake-2'], until: ['exited'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    await h.host.onSessionDeleted('s1');
    await expect.poll(() => h.pendingTimers).toBe(base);
  });

  it('a fifth concurrent wait from one caller is rate_limited', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    for (let i = 0; i < 4; i += 1)
      rawWait(ca, 1000 + i, { sessions: ['fake-2'], until: ['exited'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 4);
    const r = await ca.call('wait_sessions', { sessions: ['fake-2'], until: ['exited'] });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('rate_limited');
  });

  it('an unknown session is unknown_session naming it, with the listed handles as valid', async () => {
    const h = harness();
    const { ca } = await pairForWait(h);
    const r = await ca.call('wait_sessions', { sessions: ['nope'], until: ['exited'] });
    expect(r.body.error.code).toBe('unknown_session');
    expect(r.body.error.message).toContain('nope');
    expect(r.body.error.valid).toEqual(['fake-1', 'fake-2']);
    expect(r.body.error.hint).toEqual(expect.stringContaining('valid'));
  });

  it('a timeout over the caller budget is trimmed and reports clamped_to', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', { sessions: ['fake-2'], until: ['exited'], timeout_s: 540 });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    // An unknown caller's 25 s budget less the 5 s reply margin.
    h.advance(20_000);
    expect((await p).body).toEqual({
      fired: [],
      timed_out: true,
      states: [{ session: 'fake-2', presence: 'idle', needs_you: false, unread_from: 0 }],
      clamped_to: 20,
    });
  });

  it('a timeout within the caller budget has no clamped_to', async () => {
    const h = harness({ manualTimers: true });
    const { ca } = await pairForWait(h);
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', { sessions: ['fake-2'], until: ['exited'], timeout_s: 5 });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    h.advance(5_000);
    expect(Object.keys((await p).body)).not.toContain('clamped_to');
  });

  it('a session cannot wait on itself', async () => {
    const h = harness();
    const { ca } = await pairForWait(h);
    const r = await ca.call('wait_sessions', { sessions: ['fake-1'], until: ['exited'] });
    expect(r.body.error.code).toBe('invalid_args');
    expect(r.body.error.message).toBe("a session can't wait on itself");
  });

  it.each([
    ['an empty until', { sessions: ['fake-2'], until: [] }],
    ['an unknown condition', { sessions: ['fake-2'], until: ['bogus'] }],
    ['a timeout above 540 s', { sessions: ['fake-2'], until: ['exited'], timeout_s: 541 }],
    ['no sessions', { sessions: [], until: ['exited'] }],
  ])('%s is invalid_args', async (_name, args) => {
    const h = harness();
    const { ca } = await pairForWait(h);
    const r = await ca.call('wait_sessions', args);
    expect(r.body.error.code).toBe('invalid_args');
  });
});

describe('createConduitMcpHost — stuck screens (CON-151)', () => {
  const UPDATE_PROMPT = [
    '  Update available · 0.166.0 → 0.167.0',
    '  Release notes: https://github.com/openai/codex/releases/latest',
    '',
    '› 1. Update now (runs `powershell ...`)',
    '  2. Skip',
    '  3. Skip until next version',
    '',
    '  enter continue · esc skip',
  ].join('\r\n');
  const UPDATE = { kind: 'update-prompt', reason: 'Codex is asking whether to update' };
  // Enough rows to scroll the prompt off the live bottom.
  const FILLER = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n');

  /** Stamps the output the way the attention does: each output is new, so the feed sees it. */
  const print = (h: Harness, id: string, data: string) => {
    h.clock.t += 1;
    h.output(id, data);
    h.lastOut.set(id, h.clock.t);
  };
  /** Screen reads of one session by one tick. The notice pass reads handled sessions too. */
  const readsOf = async (h: Harness, id: string) => {
    const from = h.screenReads.length;
    await h.host.tick();
    return h.screenReads.slice(from).filter((x) => x === id).length;
  };
  const codex = (h: Harness, id = 's3') => {
    h.sessions.set(id, session(id, { agentId: 'codex' }));
    return launch(h, id, CODEX, spec('/usr/bin/codex'));
  };

  it('reports a stuck screen once, not again while it stays', async () => {
    const h = harness();
    await h.host.start();
    await codex(h);
    print(h, 's3', UPDATE_PROMPT);
    await h.host.tick();
    print(h, 's3', 'still waiting');
    await h.host.tick();
    expect(h.stuckCalls).toEqual([['s3', UPDATE]]);
  });

  it('reads at most once per second, and a recovered screen clears the stuck fact', async () => {
    const h = harness();
    await h.host.start();
    await codex(h);
    print(h, 's3', UPDATE_PROMPT);
    await h.host.tick();
    print(h, 's3', FILLER);
    await h.host.tick();
    expect(h.stuckCalls).toEqual([['s3', UPDATE]]);
    settle(h);
    await h.host.tick();
    expect(h.stuckCalls).toEqual([
      ['s3', UPDATE],
      ['s3', null],
    ]);
  });

  it('reads the screen only after output it has not yet seen', async () => {
    const h = harness();
    await h.host.start();
    await codex(h);
    const idle = await readsOf(h, 's3');
    print(h, 's3', UPDATE_PROMPT);
    expect(await readsOf(h, 's3')).toBe(idle + 1);
    settle(h);
    expect(await readsOf(h, 's3')).toBe(idle);
  });

  it('never reads a session with no CLI kind for its stuck screen', async () => {
    const h = harness();
    await h.host.start();
    await launch(h, 's1');
    const idle = await readsOf(h, 's1');
    print(h, 's1', UPDATE_PROMPT);
    expect(await readsOf(h, 's1')).toBe(idle);
    expect(h.stuckCalls).toEqual([]);
  });

  it('a relaunched session reports its stuck screen again', async () => {
    const h = harness();
    await h.host.start();
    await codex(h);
    print(h, 's3', UPDATE_PROMPT);
    await h.host.tick();
    h.exit('s3');
    h.respawn('s3');
    print(h, 's3', UPDATE_PROMPT);
    await h.host.tick();
    expect(h.stuckCalls).toEqual([
      ['s3', UPDATE],
      ['s3', UPDATE],
    ]);
  });

  it('wait_sessions needs_you fires when a CLI screen gets stuck', async () => {
    const h = harness({ manualTimers: true });
    await h.host.start();
    const a = await launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const c = await codex(h);
    await client(h.ep, c.token);
    const base = h.pendingTimers;
    const p = ca.call('wait_sessions', { sessions: ['codex-1'], until: ['needs_you'] });
    await expect.poll(() => h.pendingTimers).toBe(base + 1);
    print(h, 's3', UPDATE_PROMPT);
    await h.host.tick();
    expect((await p).body).toMatchObject({
      fired: [{ session: 'codex-1', condition: 'needs_you' }],
    });
  });
});
