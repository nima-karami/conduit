import path from 'node:path';
import type { McpRendererMessage } from '../src/conduit-mcp/host';
import { CLI_BINARIES } from '../src/conduit-mcp/install-types';
import type { DisplayFacts } from '../src/contracts/frames';
import type { HcClient } from '../src/contracts/hc';
import type { ServerEventSink, TokenStorePort } from '../src/contracts/server-ports';
import type { RuntimeHealth, SessionView, WindowPresence } from '../src/contracts/server-protocol';
import type { InstanceNames } from '../src/contracts/session-identity';
import type { AdoptedTerminal } from '../src/contracts/terminal-runtime';
import { folderKey } from '../src/folder-key';
import { HcDisconnectedError } from '../src/hc-client';
import type { HostPlatform } from '../src/lsp-binary';
import { detectAgentClis, detectShells, hostCliScanEnv, resolveCommand } from '../src/shells';
import type { AgentDefinition } from '../src/types';
import { createDomain, type DomainLog } from './domain';
import type { ShellCore } from './lifecycle/shell';
import { type AppEventSink, createMcp, type McpServerDeps, type ServerMcp } from './mcp';
import type { PreviousShim } from './mcp/install';
import { createRuntimeServices } from './runtime';
import { RpcFault, type RpcHandler, RpcProtocolFault } from './transport/pipe';

/** C2 `sessions.changed` is coalesced to at most one per this (server-protocol.ts). */
const STATUS_RESEND_MS = 150;

export interface ServicesOptions {
  userData: string;
  names: InstanceNames;
  platform: NodeJS.Platform;
  e2e: boolean;
  appVersion: string;
  logPath: string;
  /** The server's own env: the domain reads the captured user XDG values, install reads CLI homes. */
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  hc: HcClient;
  /** `hc server start` in our HC_SESSION, with coreStartEnv/coreStartCwd (F1.4.4). */
  startCore(): Promise<void>;
  shim: { execPath: string; shimPath: string };
  packaged?: boolean;
  previousShims?: readonly PreviousShim[];
  emit: ServerEventSink;
  emitTo: AppEventSink;
  stopping(): boolean;
  /** Runtime health changes after startup; compose publishes them as `runtime.changed`. */
  onHealth(health: RuntimeHealth): void;
  log: DomainLog;
  detectShells?: () => AgentDefinition[];
  detectClis?: () => AgentDefinition[];
  resolveCommand?: (command: string) => string | undefined;
  /** Forwarded to createMcp so a unit test can skip the real MCP bind. */
  host?: McpServerDeps['host'];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const paramsOf = (params: unknown): Record<string, unknown> => (record(params) ? params : {});
const str = (p: Record<string, unknown>, key: string): string => {
  const v = p[key];
  if (typeof v !== 'string' || v === '') throw new RpcFault('invalid', `Expected ${key}`);
  return v;
};
const int = (p: Record<string, unknown>, key: string): number => {
  const v = p[key];
  if (typeof v !== 'number' || !Number.isInteger(v))
    throw new RpcFault('invalid', `Expected ${key}`);
  return v;
};
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isWindow = (w: unknown): w is WindowPresence =>
  record(w) &&
  typeof w.windowId === 'number' &&
  typeof w.focused === 'boolean' &&
  typeof w.ready === 'boolean' &&
  strings(w.visibleSessionIds) &&
  strings(w.ownedSessionIds);
const color = (v: unknown) => v === undefined || v === null || typeof v === 'string';
const isFacts = (f: unknown): f is DisplayFacts =>
  record(f) &&
  color(f.fg) &&
  color(f.bg) &&
  color(f.cursor) &&
  (f.cell === undefined ||
    f.cell === null ||
    (Array.isArray(f.cell) && f.cell.length === 2 && f.cell.every((n) => typeof n === 'number')));
/** The host switches on the type and coerces each field; only the tunnel's shape is checked here. */
const isMcpMessage = (m: unknown): m is McpRendererMessage =>
  record(m) && typeof m.type === 'string' && m.type.startsWith('mcp:');

/**
 * The server's services over one hc client: W6 runtime, W4 domain, W5 MCP, and the ShellCore and
 * C2 dispatch over them. Construction order breaks the cycle (W6 needs W5's tokens, W4 needs W5's
 * launch, W5 needs W4): the two W5 ports are forwarded lazily, and nothing calls them before
 * createServices returns.
 */
export function createServices(o: ServicesOptions) {
  const { log } = o;
  let mcp: ServerMcp | undefined;
  const m = (): ServerMcp => {
    if (!mcp) throw new Error('MCP not composed yet');
    return mcp;
  };
  const tokens: TokenStorePort = {
    reserve: (sessionId, ids) => m().tokens.reserve(sessionId, ids),
    resolveAddress: (launchId, address) => m().tokens.resolveAddress(launchId, address),
    markUnconfirmed: (launchId) => m().tokens.markUnconfirmed(launchId),
    markSuperseded: (launchId) => m().tokens.markSuperseded(launchId),
    rows: () => m().tokens.rows(),
    revoke: (key) => m().tokens.revoke(key),
  };

  let statusOf: (sessionId: string) => Partial<SessionView> = () => ({});
  const withStatus = (sessions: SessionView[]): SessionView[] =>
    sessions.map((s) => ({ ...s, ...statusOf(s.id) }));
  let resendTimer: ReturnType<typeof setTimeout> | undefined;
  const invalidateSessions = () => {
    if (resendTimer) return;
    resendTimer = setTimeout(() => {
      resendTimer = undefined;
      o.emit('sessions.changed', { sessions: withStatus(domain.snapshot().sessions) });
    }, STATUS_RESEND_MS);
  };
  const emit: ServerEventSink = (type, data) => {
    if (type === 'sessions.changed') {
      invalidateSessions();
      return;
    }
    o.emit(type, data);
    // Tool lists and waiting asks re-resolve against the new policy.
    if (type === 'serverSettings.changed') mcp?.refresh();
  };

  const rt = createRuntimeServices({
    hc: o.hc,
    tokens,
    emit,
    instance: o.names.instance,
    hcSession: o.names.hcSession,
    appVersion: o.appVersion,
    logPath: o.logPath,
    userData: o.userData,
    recording: () => domain.settings().scrollbackPersistence,
    log: (message) => log.info('runtime', message),
  });
  const { runtime, attention, scrollback } = rt;
  statusOf = (id) => attention.statusOf(id);

  const hostPlatform: HostPlatform =
    o.platform === 'win32' ? 'win32' : o.platform === 'darwin' ? 'darwin' : 'linux';
  const resolve = o.resolveCommand ?? ((c: string) => resolveCommand(c, hostPlatform));
  const domain = createDomain({
    userData: o.userData,
    homeDir: o.homeDir,
    platform: o.platform,
    instance: o.names.instance,
    e2e: o.e2e,
    env: o.env,
    runtime,
    launch: {
      whenLaunchReady: () => m().launch.whenLaunchReady(),
      prepareLaunch: (sessionId, def, spec, ids) =>
        m().launch.prepareLaunch(sessionId, def, spec, ids),
      async onSessionDeleted(sessionId) {
        await m().launch.onSessionDeleted(sessionId);
        runtime.forgetSession(sessionId);
        attention.forgetSession(sessionId);
      },
    },
    drafts: { noteHostInput: (sessionId, data) => m().draft.noteHostInput(sessionId, data) },
    scrollback,
    attention,
    typing: rt.typing,
    emit,
    stopping: o.stopping,
    installState: (cli) => m().installState(cli),
    detectShells: o.detectShells ?? detectShells,
    detectClis: o.detectClis ?? (() => detectAgentClis(hostCliScanEnv())),
    resolveCommand: resolve,
    lastSizeOf: (id) => runtime.lastSizeOf(id),
    log,
  });

  mcp = createMcp({
    sessions: domain.sessions,
    domain: domain.domain,
    attention,
    typing: rt.typing,
    screens: rt.screens,
    runtime,
    emit,
    emitTo: o.emitTo,
    dir: path.join(o.userData, 'conduit-mcp'),
    endpointPath: o.names.mcpEndpoint,
    shim: o.shim,
    homeDir: o.homeDir,
    platform: hostPlatform,
    e2e: o.e2e,
    // v0.51's e2e seam; the app's env reaches the server through its supervisor start.
    ...(o.host || (o.e2e && o.env.CONDUIT_E2E_DETECT_GRACE_MS)
      ? {
          host: {
            ...o.host,
            ...(o.e2e && o.env.CONDUIT_E2E_DETECT_GRACE_MS
              ? { detectGraceMs: Number(o.env.CONDUIT_E2E_DETECT_GRACE_MS) }
              : {}),
          },
        }
      : {}),
    log,
    install: {
      env: o.env,
      userDataDir: o.userData,
      onPath: (cli) => CLI_BINARIES[cli].some((b) => resolve(b) !== undefined),
      // Any folder of an open session, never an arbitrary path (as main.ts today).
      knownHome: (p) => {
        const k = folderKey(p);
        for (const s of domain.sessions.list()) {
          const hit = [s.home, ...s.roots].find((f) => folderKey(f) === k);
          if (hit !== undefined) return hit;
        }
        return null;
      },
    },
  });
  const server = mcp;

  const offChange = attention.onChange(invalidateSessions);
  const offEdge = attention.onEdge((edge) => emit('attention.edge', edge));
  let started = false;
  // Startup's own health is the start() verdict; forwarding reconcile's publish would report
  // `ready` before the MCP endpoint listens (F1.4.6).
  const offHealth = runtime.onHealth((h) => {
    if (started) o.onHealth(h);
  });

  let adoptedOnce = false;
  let mcpStarted = false;
  let installStarted = false;
  const core: ShellCore = {
    async start() {
      if (o.names.hcEndpointError) {
        log.warn('hc', o.names.hcEndpointError);
        return { state: 'unavailable', reason: o.names.hcEndpointError, logPath: o.logPath };
      }
      if (!installStarted && o.packaged && !o.e2e) {
        const gateMigrated = domain.settings().mcpGateMigrated;
        const result = server.installStartup({ previous: o.previousShims ?? [], gateMigrated });
        if (result.gateMigrated !== gateMigrated)
          await domain.handle({
            id: 0,
            method: 'serverSettings.patch',
            params: { patch: { mcpGateMigrated: result.gateMigrated } },
          });
        installStarted = true;
      }
      if (!adoptedOnce) {
        try {
          await runtime.subscribe();
        } catch (error) {
          if (error instanceof HcDisconnectedError)
            await o
              .startCore()
              .catch((e: unknown) => log.warn('hc', `core start failed: ${String(e)}`));
          throw error;
        }
        let adopted: AdoptedTerminal[] = [];
        try {
          adopted = await runtime.reconcile();
        } catch (error) {
          // Cold starts wait on the first adopted() with no timeout, so a failed reconcile still ends it.
          log.error('runtime', `reconcile failed: ${String(error)}`);
        }
        domain.adopted(adopted);
        server.resumeAdopted(adopted);
        adoptedOnce = true;
      }
      if (!mcpStarted) {
        // See docs/specs/archive/2026-11-01-three-process-architecture.md F1.4.5-6.
        await server.start();
        mcpStarted = true;
      }
      started = true;
      return runtime.health();
    },
    beginStopping: (mode) => runtime.beginStopping(mode),
    killSessions: () => runtime.killSessions(),
    async persist() {
      runtime.detachStreams();
      await domain.persist();
      await scrollback.flushPending();
    },
    async idleState() {
      const rows = server.tokens.rows();
      return {
        liveTerminals: await runtime.liveTerminals(),
        pendingTimers: domain.pendingTimers(),
        busyTokens:
          rows.state === 'unreadable' ||
          (rows.state === 'loaded' &&
            rows.rows.some((r) => r.state === 'reserved' || r.state === 'unconfirmed')),
      };
    },
    snapshot() {
      const snap = domain.snapshot();
      return {
        ...snap,
        sessions: withStatus(snap.sessions),
        mcp: server.uiState(),
        pendingAsks: server.pendingAsks(),
      };
    },
  };

  /** domain.handle ?? MCP and the term/ui notifications ?? method_not_found (compose's fallthrough). */
  const dispatch: RpcHandler = (request, peer) => {
    const owned = domain.handle(request);
    if (owned) return owned;
    const p = paramsOf(request.params);
    switch (request.method) {
      case 'term.input': {
        const data = p.data;
        if (typeof data !== 'string') throw new RpcFault('invalid', 'Expected data');
        server.termInput({
          sessionId: str(p, 'sessionId'),
          generation: int(p, 'generation'),
          data,
        });
        return { result: {} };
      }
      case 'term.resize': {
        const sessionId = str(p, 'sessionId');
        const size = { cols: int(p, 'cols'), rows: int(p, 'rows') };
        runtime.resize(sessionId, size);
        domain.resized(sessionId, size);
        return { result: {} };
      }
      case 'term.facts': {
        if (!isFacts(p.facts)) throw new RpcFault('invalid', 'Expected facts');
        runtime.facts(str(p, 'sessionId'), p.facts);
        return { result: {} };
      }
      case 'ui.presence': {
        const windows = p.windows;
        if (!Array.isArray(windows) || !windows.every(isWindow))
          throw new RpcFault('invalid', 'Expected windows');
        domain.presence(windows);
        server.presence(peer, windows);
        return { result: {} };
      }
      case 'mcp.fromRenderer': {
        const message = p.message;
        if (!isMcpMessage(message)) throw new RpcFault('invalid', 'Expected an mcp message');
        return server
          .fromRenderer(peer, { windowId: int(p, 'windowId'), message })
          .then((result) => ({ result }));
      }
      case 'mcp.installStatus': {
        const projectPath = p.projectPath;
        if (projectPath !== null && typeof projectPath !== 'string')
          throw new RpcFault('invalid', 'Expected projectPath');
        return { result: server.installStatus(projectPath) };
      }
      case 'mcp.installAct':
        return { result: server.installAct(p.request) };
      default:
        throw new RpcProtocolFault(-32601, 'Method not found');
    }
  };

  let closing: Promise<void> | undefined;
  return {
    core,
    dispatch,
    runtime,
    domain,
    mcp: server,
    attention,
    scrollback,
    connected: () => domain.reloadAgents(),
    disconnected: (peer: object) => server.appDisconnected(peer),
    /** Idempotent: both the stop paths and the exit handler reach it. */
    close(): Promise<void> {
      closing ??= (async () => {
        clearTimeout(resendTimer);
        offChange();
        offEdge();
        offHealth();
        try {
          await server.stop();
        } catch (error) {
          log.error('mcp', `stop failed: ${String(error)}`);
        }
        domain.dispose();
        attention.dispose();
        await runtime.close();
      })();
      return closing;
    },
  };
}

export type Services = ReturnType<typeof createServices>;
