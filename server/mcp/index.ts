import * as path from 'node:path';
import { UI_TIMEOUT_MS } from '../../src/conduit-mcp/call-flow';
import {
  type ConduitMcpHost,
  type ConduitMcpHostDeps,
  createConduitMcpHost,
  type McpRendererMessage,
} from '../../src/conduit-mcp/host';
import type { GateRow, McpInstallDeps } from '../../src/conduit-mcp/install';
import type { McpInstallResult, McpInstallStatus } from '../../src/conduit-mcp/install-types';
import type { McpUiState } from '../../src/conduit-mcp/ui-types';
import type { HookPost } from '../../src/contracts/hook-protocol';
import type {
  DraftPort,
  LaunchPort,
  McpHostDeps,
  ServerEventSink,
  TokenStorePort,
} from '../../src/contracts/server-ports';
import type {
  PendingAsk,
  ServerEvent,
  ServerEvents,
  ServerNotifications,
  WindowPresence,
} from '../../src/contracts/server-protocol';
import type { AdoptedTerminal } from '../../src/contracts/terminal-runtime';
import type { HostPlatform } from '../../src/lsp-binary';
import type { HostToWebview } from '../../src/protocol';
import { createBindingStore } from './bindings-file';
import { createShimEndpoint } from './endpoint';
import { createServerInstall, type PreviousShim } from './install';
import { type AppConnection, createPresenceMirror } from './presence';
import { createPersistentTokenStore, type PersistentTokenStoreOptions } from './token-file';

export type { AppConnection } from './presence';

/** As main.ts today: input fires per keystroke, a touch per keystroke would write per character. */
const INPUT_TOUCH_INTERVAL_MS = 30_000;
/** D8: how long waiting asks outlive the last app connection before ui_unavailable. */
const APP_GRACE_MS = 5_000;
/** The sender of a renderer message from a window no presence named: owns nothing, never ready. */
const NO_WINDOW = 0;

/** One app connection's event stream; the transport sends it to that peer only. */
export type AppEventSink = <E extends ServerEvent>(
  conn: AppConnection,
  type: E,
  data: ServerEvents[E],
) => void;

type HostTestSeams = Pick<
  ConduitMcpHostDeps,
  | 'now'
  | 'sleep'
  | 'storeIo'
  | 'listen'
  | 'tickMs'
  | 'detectGraceMs'
  | 'newAskId'
  | 'setTimer'
  | 'clearTimer'
>;

export interface McpServerDeps extends Omit<McpHostDeps, 'tokens'> {
  /** userData/conduit-mcp: tokens.json, handles.json, messages.log, per-launch configs. */
  dir: string;
  endpointPath: string;
  /** The write-once runtime/shim/ node and script every CLI entry and launch argv points at (D2b). */
  shim: { execPath: string; shimPath: string };
  /** The copied Claude hook client; null = no hooks injected (spec 2026-11-13 §3). */
  hookClientPath: string | null;
  gitBashPath: () => string | undefined;
  /** A hook post the endpoint authenticated. */
  onHook: (sessionId: string, post: HookPost) => void;
  homeDir: string;
  platform: HostPlatform;
  e2e: boolean;
  log: ConduitMcpHostDeps['log'];
  install: Pick<McpInstallDeps, 'env' | 'userDataDir' | 'onPath' | 'knownHome' | 'io'>;
  host?: HostTestSeams;
  randomToken?: PersistentTokenStoreOptions['randomToken'];
  /**
   * Window-routed ui.post goes to the window's own app connection, under its own window id.
   * Compose provides it from the transport's per-peer send (PipeTransport.emitTo).
   */
  emitTo: AppEventSink;
}

export interface ServerMcp {
  /** For W6's spawn and reconcile; W5 alone writes tokens.json. */
  tokens: TokenStorePort;
  /** For W4. */
  launch: LaunchPort;
  /** For W4's runAddDir. */
  draft: DraftPort;
  /** DomainDeps.closeWhenDone: a closeWhenDone program exited; see ConduitMcpHost.closeWhenDone. */
  closeWhenDone(sessionId: string): Promise<void>;
  /** Startup ordering: see docs/specs/archive/2026-11-01-three-process-architecture.md F1.4.5-6. */
  start(): Promise<void>;
  resumeAdopted(terminals: readonly AdoptedTerminal[]): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
  /** C2 `term.input`: the host's bookkeeping runs before the TypingPort write (F8). */
  termInput(n: ServerNotifications['term.input']): void;
  /** C2 `ui.presence` from one app connection. */
  presence(conn: AppConnection, windows: readonly WindowPresence[]): void;
  appDisconnected(conn: AppConnection): void;
  /** C2 `mcp.fromRenderer`. */
  fromRenderer(
    conn: AppConnection,
    params: { windowId: number; message: McpRendererMessage },
  ): Promise<{ reply?: HostToWebview }>;
  /** For the snapshot: answerable, not only displayable (F7). */
  pendingAsks(): PendingAsk[];
  uiState(): McpUiState;
  /** After a server-settings change: tool lists and waiting asks re-resolve. */
  refresh(): void;
  installStatus(projectPath: string | null): McpInstallStatus;
  /** C2 `mcp.installAct`; the request is coerced here, the renderer is never load-bearing. */
  installAct(request: unknown): McpInstallResult;
  /** For DomainPort.installState. */
  installState: ReturnType<typeof createServerInstall>['userState'];
  /** The packaged startup pass: CLI-entry migration, repair, the one-time gate rules. */
  installStartup(opts: { previous: readonly PreviousShim[]; gateMigrated: boolean }): {
    gateMigrated: boolean;
    rows: GateRow[];
  };
}

/**
 * W5: the W0b host (src/conduit-mcp/host.ts) inside the server, over C7. Everything here is the
 * server-side wiring the host leaves to its embedder: the persistent token store, the C6 endpoint,
 * the presence mirror and its window events, the C2 window-id namespace, the pending-ask list, and
 * the term.input path.
 */
export function createMcp(deps: McpServerDeps): ServerMcp {
  const now = deps.host?.now ?? Date.now;
  const tokens = createPersistentTokenStore({
    file: path.join(deps.dir, 'tokens.json'),
    now,
    randomToken: deps.randomToken,
    warn: (message, data) => deps.log.warn('conduit-mcp', message, data),
  });
  const bindings = createBindingStore({
    file: path.join(deps.dir, 'bindings.json'),
    warn: (message, data) => deps.log.warn('conduit-mcp', message, data),
  });
  let host: ConduitMcpHost | undefined;
  const setTimer = deps.host?.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.host?.clearTimer ??
    ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout> | undefined));
  let graceTimer: unknown;
  const cancelGrace = () => {
    if (graceTimer === undefined) return;
    clearTimer(graceTimer);
    graceTimer = undefined;
  };
  const presence = createPresenceMirror({
    attention: deps.attention,
    onSessionMoved: (s) => host?.onSessionMoved(s),
    onWindowReset: (w) => host?.onWindowReset(w),
  });

  /** Each open ask, with the namespaced window it was shown in. */
  const asks = new Map<string, { ask: PendingAsk; windowId: number | null }>();
  /** Each open app-control UI step, with its window and caller; none outlives UI_TIMEOUT_MS. */
  const uiWaits = new Map<string, { sessionId: string; windowId: number; at: number }>();
  const approvalsChanged = () =>
    deps.emit('approvals.changed', { pending: [...asks.values()].map((a) => a.ask) });

  const track = (post: ServerEvents['ui.post']) => {
    const m = post.message;
    if (m.type === 'mcp:ask') {
      const { type: _type, ...ask } = m;
      asks.set(m.askId, { ask, windowId: presence.ownerWindowOf(m.callerSessionId) });
      approvalsChanged();
    } else if (m.type === 'mcp:askClosed') {
      if (asks.delete(m.askId)) approvalsChanged();
    } else if (m.type === 'mcp:ui' && post.route.kind === 'window') {
      const t = now();
      // The flow never says when an unanswered step ends; its own bound does.
      for (const [id, w] of uiWaits) if (t - w.at > UI_TIMEOUT_MS) uiWaits.delete(id);
      uiWaits.set(m.requestId, { sessionId: m.sessionId, windowId: post.route.windowId, at: t });
    }
  };

  const emit: ServerEventSink = (type, data) => {
    if (type !== 'ui.post') return deps.emit(type, data);
    // The sink's generic doesn't narrow `data` with `type`; this is that narrowing.
    const post = data as ServerEvents['ui.post'];
    track(post);
    if (post.route.kind !== 'window') return deps.emit('ui.post', post);
    const local = presence.localOf(post.route.windowId);
    // Thrown, not dropped: the host's UI step then answers window_not_ready instead of timing out.
    if (!local) throw new Error(`window ${post.route.windowId} is gone`);
    deps.emitTo(local.conn, 'ui.post', {
      ...post,
      route: { kind: 'window', windowId: local.windowId },
    });
  };

  /**
   * F7 step 4: a wait answers to its session's owner window in the latest presence, so an app that
   * reconnected (new connection, new namespaced ids) can answer what the old one was shown.
   */
  const answeringWindow = (bound: number, sessionId: string, sender: number): number =>
    sender !== bound && presence.ownerWindowOf(sessionId) === sender && presence.windowReady(sender)
      ? bound
      : sender;

  const install = createServerInstall({
    ...deps.install,
    homeDir: deps.homeDir,
    platform: deps.platform,
    execPath: deps.shim.execPath,
    shimPath: deps.shim.shimPath,
    log: deps.log,
  });

  /** The generation each session last launched or was adopted at; any other `spawned` is an adopt. */
  const prepared = new Map<string, number>();
  const resumeAdopted = (
    terminals: readonly Pick<AdoptedTerminal, 'sessionId' | 'generation' | 'launchId'>[],
  ) => {
    for (const t of terminals) {
      if (prepared.get(t.sessionId) === t.generation) continue;
      const def = deps.domain.defOf(t.sessionId);
      if (!def || !host) continue;
      host.resumeLaunch(t.sessionId, def, t, bindings.get(t.sessionId) ?? null);
      prepared.set(t.sessionId, t.generation);
    }
  };
  // Subscribed before the host, so the adopted session's state exists when its spawned handler runs.
  const stopAdopt = deps.runtime.on((e) => {
    // An older generation's late exit must not make the live one's next `spawned` read as an adopt.
    if (e.type === 'exit' && prepared.get(e.sessionId) === e.generation)
      prepared.delete(e.sessionId);
    if (e.type === 'exit' && bindings.get(e.sessionId)?.generation === e.generation)
      bindings.delete(e.sessionId);
    if (e.type !== 'spawned' || prepared.get(e.sessionId) === e.generation) return;
    const terminal = deps.runtime.get(e.sessionId);
    if (terminal) resumeAdopted([terminal]);
  });

  const h = createConduitMcpHost({
    sessions: deps.sessions,
    domain: deps.domain,
    attention: deps.attention,
    typing: deps.typing,
    screens: deps.screens,
    runtime: deps.runtime,
    tokens,
    emit,
    dir: deps.dir,
    endpointPath: deps.endpointPath,
    execPath: deps.shim.execPath,
    shimPath: deps.shim.shimPath,
    hookClientPath: deps.hookClientPath,
    gitBashPath: deps.gitBashPath,
    homeDir: deps.homeDir,
    platform: deps.platform,
    e2e: deps.e2e,
    log: deps.log,
    ownerWindowOf: presence.ownerWindowOf,
    windowReady: presence.windowReady,
    onScreen: presence.onScreen,
    createEndpoint: (o) => createShimEndpoint({ ...o, tokens, onHook: deps.onHook }),
    onBindingChanged: (sessionId, binding) => {
      if (binding) bindings.set({ sessionId, ...binding });
      else bindings.delete(sessionId);
    },
    ...deps.host,
  });
  host = h;

  return {
    tokens,
    launch: {
      whenLaunchReady: () => h.whenLaunchReady(),
      prepareLaunch(sessionId, def, spec, ids) {
        prepared.set(sessionId, ids.generation);
        // D28: a binding belongs to one generation.
        bindings.delete(sessionId);
        return h.prepareLaunch(sessionId, def, spec, ids);
      },
      async onSessionDeleted(sessionId) {
        await h.onSessionDeleted(sessionId);
        bindings.delete(sessionId);
        prepared.delete(sessionId);
      },
    },
    draft: { noteHostInput: (sessionId, data) => h.noteHostInput(sessionId, data) },
    closeWhenDone: (sessionId) => h.closeWhenDone(sessionId),
    start: () => h.start(),
    resumeAdopted,
    async stop() {
      cancelGrace();
      stopAdopt();
      await h.stop();
    },
    tick: () => h.tick(),

    termInput({ sessionId, generation, data }) {
      // A stale generation's write is dropped, so its bytes never reached this program.
      if (deps.runtime.get(sessionId)?.generation !== generation) return;
      h.onRendererInput(sessionId, data);
      deps.attention.recordInput(sessionId, now());
      deps.sessions.touch(sessionId, INPUT_TOUCH_INTERVAL_MS);
      deps.typing.write(sessionId, data, { generation });
    },

    presence(conn, windows) {
      // Only a ready window can answer an ask: an app with none is still away.
      if (windows.some((w) => w.ready)) cancelGrace();
      presence.update(conn, windows);
    },
    appDisconnected(conn) {
      presence.disconnect(conn);
      if (presence.connected() || graceTimer !== undefined) return;
      graceTimer = setTimer(() => {
        graceTimer = undefined;
        h.denyAsksUnavailable();
      }, APP_GRACE_MS);
    },

    async fromRenderer(conn, { windowId, message }) {
      // Looked up, never allocated: a window no presence named answers nothing.
      let sender = presence.windowIdOf(conn, windowId) ?? NO_WINDOW;
      const ask = message.type === 'mcp:askAnswer' ? asks.get(message.askId) : undefined;
      if (ask?.windowId != null)
        sender = answeringWindow(ask.windowId, ask.ask.callerSessionId, sender);
      if (message.type === 'mcp:uiResult') {
        const wait = uiWaits.get(message.requestId);
        if (wait) sender = answeringWindow(wait.windowId, wait.sessionId, sender);
      }
      let reply: HostToWebview | undefined;
      await h.handleRenderer(
        message,
        (m) => {
          reply ??= m;
        },
        sender,
      );
      if (message.type === 'mcp:uiResult') uiWaits.delete(message.requestId);
      // The flow ends an answered ask silently; every other end posts mcp:askClosed.
      if (
        message.type === 'mcp:askAnswer' &&
        ask &&
        ask.windowId === sender &&
        (message.answer === 'approve' ||
          message.answer === 'deny' ||
          message.answer === 'always') &&
        asks.delete(message.askId)
      )
        approvalsChanged();
      return reply ? { reply } : {};
    },

    pendingAsks: () => [...asks.values()].map((a) => a.ask),
    uiState: () => h.uiState(),
    refresh: () => h.refresh(),

    installStatus: (projectPath) => install.status(projectPath),
    installAct(request) {
      const r = install.act(request);
      if (r.ok) h.onInstallChanged();
      return r;
    },
    installState: (cli) => install.userState(cli),
    installStartup(opts) {
      const r = install.startup(opts);
      h.onInstallChanged();
      return r;
    },
  };
}
