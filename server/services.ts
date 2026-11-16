import { existsSync, promises as fsPromises, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../src/atomic-write';
import { isCountedInput } from '../src/conduit-mcp/draft-input';
import type { McpRendererMessage } from '../src/conduit-mcp/host';
import { CLI_BINARIES } from '../src/conduit-mcp/install-types';
import type { DisplayFacts } from '../src/contracts/frames';
import type { HcClient } from '../src/contracts/hc';
import type { MonitorSession } from '../src/contracts/link-protocol';
import type { ServerEventSink, TokenStorePort } from '../src/contracts/server-ports';
import type { RuntimeHealth, SessionView, WindowPresence } from '../src/contracts/server-protocol';
import type { InstanceNames } from '../src/contracts/session-identity';
import type { AdoptedTerminal } from '../src/contracts/terminal-runtime';
import { folderKey } from '../src/folder-key';
import { HcDisconnectedError } from '../src/hc-client';
import type { HostPlatform } from '../src/lsp-binary';
import {
  detectAgentClis,
  detectShells,
  gitBashPath,
  hostCliScanEnv,
  resolveCommand,
} from '../src/shells';
import type { AgentDefinition } from '../src/types';
import { createDomain, type DomainLog } from './domain';
import { createCodexRolloutWatch } from './domain/codex-rollout-watch';
import type { ShellCore } from './lifecycle/shell';
import { type AppEventSink, createMcp, type McpServerDeps, type ServerMcp } from './mcp';
import { activityAuditSink } from './mcp/activity-audit-sink';
import { ensureHookClient } from './mcp/hook-client-file';
import type { PreviousShim } from './mcp/install';
import { createNetwork, type NetworkService } from './network';
import { loadIdentity, readOnlyMachineId } from './network/identity';
import { monitorRows } from './network/monitor-publisher';
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
  // Built after the domain (it reads settings) but referenced by emit, which runs earlier.
  let network: NetworkService | null = null;
  const emit: ServerEventSink = (type, data) => {
    if (type === 'sessions.changed') {
      network?.localChanged();
      invalidateSessions();
      return;
    }
    o.emit(type, data);
    // Tool lists and waiting asks re-resolve against the new policy.
    if (type === 'serverSettings.changed') {
      mcp?.refresh();
      void network?.settingsChanged();
    }
    // A peer's monitor view follows local sessions, asks and unread counts.
    if (type === 'ui.post') network?.localChanged();
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
    observed: {
      record: (sessionId, cli, entry) => m().recordObserved(sessionId, cli, entry),
    },
    createCodexWatch: createCodexRolloutWatch,
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
    closeWhenDone: (id) => m().closeWhenDone(id),
    log,
  });

  /**
   * The human input path shared by C2 `term.input` (a generation the app read) and network drive
   * (`null`: the live generation, since a remote typist has no generation to quote).
   */
  const applyHumanInput = (sessionId: string, data: string, generation: number | null): boolean => {
    const current = generation ?? runtime.get(sessionId)?.generation;
    // No live terminal: nothing to write to, and a missing generation must not match one.
    if (current === undefined) return false;
    const delivered = m().termInput({ sessionId, generation: current, data });
    // see spec R4: a real keystroke that reached the program, not a terminal's own reply.
    if (delivered && isCountedInput(data)) domain.humanInput(sessionId);
    return delivered;
  };

  /** C2 `sessions.create` then `sessions.start`, the same domain handlers the app's open runs. */
  const openSession = async (agentId: string, folder: string): Promise<string> => {
    const created = await domain.handle({
      id: 0,
      method: 'sessions.create',
      params: { agentId, home: folder },
    });
    if (!created || !('result' in created))
      throw new RpcFault('refused', 'could not create the session');
    const { sessionId } = created.result as { sessionId: string };
    // A start that refused or failed still leaves the session in its pane, as an app open does.
    const started = await domain.handle({ id: 0, method: 'sessions.start', params: { sessionId } });
    if (!started || 'error' in started) log.warn('drive', 'session created but did not start');
    return sessionId;
  };

  /** C2 `sessions.remove`, the server-local close that kills or retires the terminal. */
  const closeSession = async (sessionId: string): Promise<void> => {
    const answer = await domain.handle({ id: 0, method: 'sessions.remove', params: { sessionId } });
    if (answer && 'error' in answer) throw answer.error;
  };

  const networkDir = path.join(o.userData, 'network');
  const loaded = loadIdentity(networkDir);
  let machineId: string;
  if (loaded.kind === 'newer') {
    log.error('network', 'identity.json is from a newer build; networking is off', {});
    const readOnly = readOnlyMachineId(networkDir);
    if (readOnly === null) {
      throw new Error(
        `${path.join(networkDir, 'identity.json')} is unreadable; no server identity`,
      );
    }
    machineId = readOnly;
  } else {
    if (loaded.kind === 'recovered') {
      log.error('network', 'identity.json was unreadable; moved to identity.corrupt.json', {
        machineId: loaded.identity.machineId,
      });
    }
    machineId = loaded.identity.machineId;
  }
  network =
    loaded.kind === 'newer'
      ? null
      : createNetwork({
          dir: networkDir,
          identity: loaded.identity,
          settings: () => domain.settings(),
          emit: (state) => o.emit('network.changed', state),
          emitTo: o.emitTo,
          observe: (sessionId, events) => runtime.observe(sessionId, events),
          log: {
            debug: (msg, data) => log.debug('network', msg, data),
            warn: (msg, data) => log.warn('network', msg, data),
            error: (msg, data) => log.error('network', msg, data),
          },
          drive: {
            applyHumanInput: (sessionId, data) => applyHumanInput(sessionId, data, null),
            resize: (sessionId, size) => {
              runtime.resize(sessionId, size);
              domain.resized(sessionId, size);
            },
            liveSession: (sessionId) => runtime.get(sessionId)?.state === 'live',
            agentExists: (agentId) =>
              domain.snapshot().stores.agents.some((agent) => agent.id === agentId),
            isDirectory: async (absolutePath) =>
              (await fsPromises.stat(absolutePath).catch(() => null))?.isDirectory() === true,
            openSession,
            closeSession,
          },
          monitor: {
            sessions: () => monitorSessions(),
            requests: () => mcp?.networkPort().requestsSummary() ?? [],
            youUnread: () => mcp?.networkPort().youUnread() ?? 0,
            ownerPresence: () => mcp?.networkPort().ownerPresence() ?? 'here',
            agents: () =>
              domain.snapshot().stores.agents.map((a) => ({ id: a.id, label: a.label })),
          },
        });

  /** Local sessions with a handle, joined with their attention facts, as a peer sees them. */
  const monitorSessions = (): MonitorSession[] =>
    monitorRows(domain.snapshot().sessions, mcp?.networkPort().localDirectory() ?? []);

  mcp = createMcp({
    machineId,
    network: network?.port(),
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
    hookClientPath: ensureHookClient({
      // Packaged: the install's resources folder (beside the shim the app passes as previous);
      // dev: the shim's own folder in the repo.
      sourceDir: path.dirname(o.previousShims?.[0]?.shimPath ?? o.shim.shimPath),
      targetDir: path.join(o.userData, 'conduit-mcp', 'hooks'),
      fs: {
        read: (p) => {
          try {
            return readFileSync(p);
          } catch {
            // Absent from this build: ensureHookClient reports it once.
            return null;
          }
        },
        exists: (p) => existsSync(p),
        writeAtomic: (p, d) => atomicWriteFileSync(p, d),
        mkdir: (p) => mkdirSync(p, { recursive: true }),
      },
      warn: (msg, data) => log.warn('scheduler', msg, data),
    }),
    gitBashPath: () => (hostPlatform === 'win32' ? gitBashPath() : undefined),
    onHook: (sessionId, post) => domain.hookPost(sessionId, post),
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
  network?.setMcp(server.networkPort());
  network?.setAuditTap(activityAuditSink(server.recordNote));
  network?.onRevoked((machineId) => server.peerRevoked(machineId));

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
        await network?.start();
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
    if (
      request.method.startsWith('pairing.') ||
      request.method.startsWith('link.') ||
      request.method.startsWith('remote.')
    ) {
      if (!network)
        throw new RpcFault(
          'unavailable',
          'Linked machines are off: identity.json is from a newer build',
        );
      const answer = network.handle(request.method, request.params, peer);
      if (answer) return answer.then((result) => ({ result }));
    }
    const p = paramsOf(request.params);
    switch (request.method) {
      case 'term.input': {
        const data = p.data;
        if (typeof data !== 'string') throw new RpcFault('invalid', 'Expected data');
        const sessionId = str(p, 'sessionId');
        applyHumanInput(sessionId, data, int(p, 'generation'));
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
    applyHumanInput,
    openSession,
    closeSession,
    connected: () => domain.reloadAgents(),
    disconnected: (peer: object) => {
      network?.disconnected(peer);
      server.appDisconnected(peer);
    },
    /** Idempotent: both the stop paths and the exit handler reach it. */
    close(): Promise<void> {
      closing ??= (async () => {
        clearTimeout(resendTimer);
        offChange();
        offEdge();
        offHealth();
        try {
          await network?.stop();
        } catch (error) {
          log.error('network', `stop failed: ${String(error)}`);
        }
        try {
          await server.stop();
        } catch (error) {
          log.error('mcp', `stop failed: ${String(error)}`);
        }
        await domain.dispose();
        attention.dispose();
        await runtime.close();
      })();
      return closing;
    },
  };
}

export type Services = ReturnType<typeof createServices>;
