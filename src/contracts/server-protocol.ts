// C2 — app ↔ Conduit server: JSON-RPC 2.0, one message per line, on \\.\pipe\conduit-server-<h>.
// Requests and the `term.*` notifications go app → server; event notifications go server → app. Of
// this protocol only `hello`, `server.restart` and `server.stopAll` are frozen (D12): a version
// mismatch restarts the server, unless the app is the older side (D26). Within a generation their
// fields may only grow by optional ones, and readers ignore fields they don't know. The other
// cross-version edges are shim ↔ server (shim-protocol.ts), app/server ↔ hc core (hc.ts) and the
// server's persisted files (session-identity.ts SERVER_FILE_VERSION).
// Most methods carry the renderer's own message payload (src/protocol.ts) unchanged, so a change to
// those payload types is a C2 change; the per-message ownership map is
// docs/runs/2026-11-01-three-process-design/main-ts-ownership.md.
import type {
  McpInstallRequest,
  McpInstallResult,
  McpInstallStatus,
} from '../conduit-mcp/install-types';
import type { McpUiState } from '../conduit-mcp/ui-types';
import type { LauncherDTO } from '../launchers';
import type { HostToWebview, TermGeometry, WebviewToHost } from '../protocol';
import type { AppSettings } from '../settings';
import type {
  AgentDefinition,
  BriefRequest,
  Project,
  Session,
  SessionCommand,
  SessionOpener,
} from '../types';
import type { DisplayFacts } from './frames';
import type { SessionRuntime } from './session-identity';
import type { AttachTarget, FirstPaint } from './terminal-link';
import {
  LAUNCH_SETTLE_ON_STOP_MS,
  type ServerStopping,
  type SpawnFinished,
  type SpawnUnconfirmed,
} from './terminal-runtime';

export const SERVER_PROTOCOL_GENERATION = 1;

/**
 * `hello` is answered at once and carries no readiness: the server binds its pipe before any slow
 * work, so this bounds only that the server is up (D17).
 */
export const APP_HELLO_TIMEOUT_MS = 20_000;
/**
 * The server's own bound on leaving `runtime: starting`. Past it: `unavailable: 'startup timeout'`,
 * still trying in the background; it never restarts itself, and the app only shows it (D17).
 */
export const SERVER_STARTUP_DEADLINE_MS = 30_000;
/**
 * F6: after `server.restart`, how long the app waits for the supervisor's terminal (its unique name
 * and the address `hello.supervisor` reported) to finish.
 */
export const SERVER_RESTART_EXIT_WAIT_MS = 30_000;
/**
 * Uninstall's `--stop-all` (F12): no connection or no `hello` answer within this, and it works
 * against hc directly. Only this, or the connection closing before the reply, starts that fallback.
 */
export const STOP_ALL_CONNECT_TIMEOUT_MS = 5_000;
/** The stopping transition's kill and persist steps after the settle (D32). */
export const STOP_KILL_PERSIST_BUDGET_MS = 5_000;
/** The whole stopping transition: settle, then kill and persist. */
export const STOP_TRANSITION_BUDGET_MS = LAUNCH_SETTLE_ON_STOP_MS + STOP_KILL_PERSIST_BUDGET_MS;
/**
 * How long `--stop-all` waits for the reply once `server.stopAll` is written on a live connection;
 * longer than STOP_TRANSITION_BUDGET_MS. Past it, still connected, it reports the stop as failed and
 * never touches hc: the direct-hc fallback would race a server still running its own cleanup.
 */
export const STOP_ALL_ANSWER_TIMEOUT_MS = 20_000;

type Msg<T extends WebviewToHost['type']> = Omit<
  Extract<WebviewToHost, { type: T }>,
  'type' | 'requestId'
>;
type Reply<T extends HostToWebview['type']> = Omit<
  Extract<HostToWebview, { type: T }>,
  'type' | 'requestId'
>;
type Empty = Record<string, never>;

/** An open approval request; answerable from a snapshot, not only displayable (F7). */
export type PendingAsk = Reply<'mcp:ask'>;

/**
 * Session fields the app derives and owns (W7): repo detection, git info, the manual pin, the editor
 * context's auto-follow and the active repo they resolve to (src/active-repo.ts). All runtime-only,
 * never persisted. The server never sets them; the app derives `autoRepoRoot` from the server's
 * `cwd` (hc `foreground`, D38) and from its own `repo:context`.
 */
export const APP_SESSION_FIELDS = [
  'repos',
  'repoGit',
  'activeRepoRoot',
  'repoPinned',
  'pinnedRepoRoot',
  'autoRepoRoot',
] as const satisfies readonly (keyof Session)[];
export type AppSessionField = (typeof APP_SESSION_FIELDS)[number];
/** The app-local overlay; the app keys it by sessionId. */
export type AppSessionOverlay = Partial<Pick<Session, AppSessionField>>;

/** What the server sends for a session: its record plus runtime facts, never the app's fields. */
export type SessionView = Omit<Session, AppSessionField> & { runtime: SessionRuntime };
/** What the app renders: a server view with the app's overlay merged on. */
export type AppSessionView = SessionView & AppSessionOverlay;

/**
 * The app's merge on every `sessions.changed` and snapshot: the overlay always wins, so a server
 * snapshot never clobbers repo state. The app drops the overlay of a session the list no longer has.
 */
export function mergeAppOverlay(
  view: SessionView,
  overlay: AppSessionOverlay | undefined,
): AppSessionView {
  const merged: AppSessionView = { ...view };
  for (const k of APP_SESSION_FIELDS) delete merged[k];
  return overlay ? Object.assign(merged, overlay) : merged;
}

/** Where a renderer-bound message goes; the app resolves `owner` with its own session→window map. */
export type UiRoute =
  | { kind: 'owner'; sessionId: string }
  | { kind: 'window'; windowId: number }
  | { kind: 'broadcast' };

/**
 * Visibility and ownership only; typing never depends on it (D19). Window ids are resolved against the
 * latest presence: within the 5 s grace a pending ask rebinds to its session's owner there (D8). The
 * server keys the mirror by C2 connection, so ids are namespaced per app.
 */
export interface WindowPresence {
  windowId: number;
  focused: boolean;
  ready: boolean;
  visibleSessionIds: string[];
  /** Sessions this window owns. The server's ownerWindowOf/windowReady read this mirror and fail closed. */
  ownedSessionIds: string[];
}

/** Server-owned lists the app renders; each changes as a whole. */
export interface DataStores {
  agents: AgentDefinition[];
  launchers: LauncherDTO[];
  projects: Project[];
}
export type DataStore = keyof DataStores;

/**
 * `starting`: C2 is served but hc isn't ready; the app shows terminals as unavailable, not an error.
 * Bounded by SERVER_STARTUP_DEADLINE_MS, past which it is `unavailable: 'startup timeout'`.
 * `degraded`: `core replaced` = the core's hello.version ≠ the pinned one after a reconnect, e.g.
 * `hc update` run in a pane (D24); `token store unreadable` = reconcile adopted and killed nothing
 * (D21); while it lasts the MCP endpoint welcomes every hello with `draining`, so shims keep retrying
 * instead of falling back for good. Shown to the user; terminals keep working.
 */
export type RuntimeHealth =
  | { state: 'starting' }
  | { state: 'ready'; hcVersion: string }
  | {
      state: 'degraded';
      reason: 'core replaced' | 'token store unreadable';
      hcVersion: string;
    }
  | { state: 'unavailable'; reason: string; logPath: string };

/**
 * The AppSettings keys the server reads (D7). Every other key is UI and the app's alone: osAttention
 * gates only the app's OS notifications, and logging/logLevel reach the server as `server.setLogging`.
 * The app reads these keys only from its own settings.json mirror (v0.51's values on the first
 * launch), then from the snapshot and `serverSettings.changed`; the server's own file is private to it.
 */
export const SERVER_SETTINGS_KEYS = [
  'conduitMcp',
  'mcpToolPolicy',
  'mcpToolPolicyByCli',
  'mcpGateMigrated',
  'autoResumeOnLimit',
  'autoRelaunchStale',
  'restoreSessions',
  'scrollbackPersistence',
  'trackCwd',
] as const satisfies readonly (keyof AppSettings)[];
export type ServerSettings = Pick<AppSettings, (typeof SERVER_SETTINGS_KEYS)[number]>;

/** App-owned UI keys the server needs; it logs with the defaults until the first push. */
export type ServerLogging = Pick<AppSettings, 'logging' | 'logLevel'>;

export type SessionMutation =
  | { op: 'rename'; name: string }
  | { op: 'setIconOverride'; icon: string | null }
  | { op: 'setHome'; path: string }
  | { op: 'addRoot'; path: string }
  | { op: 'removeRoot'; path: string }
  | { op: 'replaceRoot'; from: string; to: string }
  | { op: 'setProject'; projectId: string | null };

export interface ServerSnapshot {
  seq: number;
  sessions: SessionView[];
  settings: ServerSettings;
  stores: DataStores;
  runtime: RuntimeHealth;
  timers: Reply<'timer:state'>;
  mcp: McpUiState;
  /** Asks still open, so an app that (re)connects mid-ask can answer them (F7). */
  pendingAsks: PendingAsk[];
}

/**
 * One error channel per method: `sessions.start` and `sessions.retryLaunch` refuse in this result,
 * never as an RPC error; `sessions.create` refuses as an RPC error (ServerErrorKind). MCP opens are
 * not C2 calls: they refuse in MCP's tool-result envelope (C7 DomainOpenOutcome → ToolError).
 */
export type SessionStartResult =
  | {
      ok: true;
      target: AttachTarget;
      generation: number;
      /**
       * false: the session was already live (today's attach path). No prelude, no second
       * `terminal.run`; the app attaches as an observer with `history: 2000`.
       */
      spawned: boolean;
      /** Stored scrollback to write before attaching, when a stale session cold-spawns (D18). */
      prelude?: FirstPaint;
    }
  | {
      /**
       * The program ended before the server's attach: the app shows an exited session with this
       * output and attaches nothing (C1 SpawnFinished).
       */
      ok: true;
      finished: SpawnFinished;
      prelude: FirstPaint;
    }
  | {
      /**
       * Nothing spawned. The pane's text for it (today's can't-start line) arrives as `term.show`
       * before this reply, through ScrollbackPort.show, so it is in the ring too.
       */
      ok: false;
      refusal: NonNullable<Session['startRefusal']> | SpawnUnconfirmed | ServerStopping;
    };

/** The supervisor as the server knows it: its unique hc name and the address hc gave it (D17). */
export interface SupervisorIdentity {
  name: string;
  terminal: string;
}

/** Which side of `hello` is newer: generation first, then semver. */
export type VersionOrder = 'same' | 'appNewer' | 'appOlder';

const semverParts = (v: string): { core: number[]; pre: string[] | null } => {
  const plain = v.split('+')[0] ?? '';
  const dash = plain.indexOf('-');
  const core = (dash < 0 ? plain : plain.slice(0, dash)).split('.');
  return {
    core: core.map((n) => Number.parseInt(n, 10) || 0),
    pre: dash < 0 ? null : plain.slice(dash + 1).split('.'),
  };
};

const NUMERIC_ID = /^\d+$/;

/** semver §11: numeric ids compare numerically and below alphanumeric ones; a prefix is lower. */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x === y) continue;
    const xNum = NUMERIC_ID.test(x);
    const yNum = NUMERIC_ID.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * F6 and D26: compare SERVER_PROTOCOL_GENERATION first, then the semver of the app and server
 * versions. A release outranks its own pre-release; pre-releases order by semver's identifier rules.
 */
export function versionOrder(
  app: { generation: number; version: string },
  server: { generation: number; version: string },
): VersionOrder {
  if (app.generation !== server.generation)
    return app.generation > server.generation ? 'appNewer' : 'appOlder';
  const a = semverParts(app.version);
  const s = semverParts(server.version);
  for (let i = 0; i < 3; i++) {
    const d = (a.core[i] ?? 0) - (s.core[i] ?? 0);
    if (d !== 0) return d > 0 ? 'appNewer' : 'appOlder';
  }
  if (a.pre === null && s.pre === null) return 'same';
  if (a.pre === null) return 'appNewer';
  if (s.pre === null) return 'appOlder';
  const d = comparePrerelease(a.pre, s.pre);
  if (d === 0) return 'same';
  return d > 0 ? 'appNewer' : 'appOlder';
}

export interface ServerMethods {
  // ── frozen across versions ──
  hello: {
    params: {
      appVersion: string;
      generation: number;
      /**
       * Reserved, unused: C2 is unauthenticated to same-user processes today (D16). A later client
       * credential goes here as an optional field, under the extension rule.
       */
      auth?: string;
    };
    result: {
      serverVersion: string;
      generation: number;
      instance: string;
      pid: number;
      /** Absent when hc couldn't start and the supervisor runs as a plain spawn. */
      supervisor?: SupervisorIdentity;
    };
  };
  /**
   * The stopping transition (D32): refuse new starts with `server_stopping`, settle in-flight launches
   * (C1 beginStopping('restart')), persist, reply, exit. The supervisor exits too, and the app waits
   * for its unique-named terminal to finish (F6); the replacement adopts or late-confirms any launch
   * left unconfirmed (D21).
   */
  'server.restart': { params: { reason: 'update' | 'user' }; result: Empty };
  /**
   * F12, and an older app's way out (D26), as the stopping transition (D32): refuse new starts, settle
   * in-flight launches (C1 beginStopping('stopAll'): still pending, and earlier `unconfirmed` rows,
   * become `superseded`), kill every role=session terminal (never the supervisor) and delete their
   * token rows and bindings, persist, reply, exit SERVER_EXIT.doneCoreIdle. The supervisor runs
   * `hc server stop` only on that code and with no other terminal live, then exits (D17).
   */
  'server.stopAll': { params: Empty; result: { killed: number } };

  // ── lifecycle ──
  'events.subscribe': { params: Empty; result: ServerSnapshot };
  /** On connect and on every change of either key (D7). */
  'server.setLogging': { params: ServerLogging; result: Empty };

  // ── sessions ──
  /**
   * Also the server-internal create behind MCP open_session/open_terminal. Refuses as an RPC error
   * (`server_stopping` while stopping); the MCP opens refuse in their tool result instead (C7
   * DomainOpenOutcome). Emits `sessions.opened` before the `sessions.changed` that
   * first lists the session, so the app applies `focus: false` before it shows it.
   */
  'sessions.create': {
    params: {
      agentId: string;
      home: string;
      name?: string;
      roots?: string[];
      projectId?: string;
      brief?: BriefRequest;
      /** An `open_terminal` session's argv. */
      command?: SessionCommand;
      openedBy?: SessionOpener;
      /** Without it the session goes to the focused window. */
      placement?: { nearSessionId?: string; focus: boolean };
      cardId?: string;
    };
    result: { sessionId: string };
  };
  /**
   * Spawns if not live; concurrent calls for one session share one spawn (F2). Resolves on hc's
   * reply or a core connection loss, never a clock; the loss is a `spawn_unconfirmed` refusal and the
   * session shows `unconfirmed` until it registers late or a person retries or discards it (D21).
   * `prelude` comes from C7 ScrollbackPort.
   */
  'sessions.start': {
    params: { sessionId: string };
    result: SessionStartResult;
  };
  /**
   * A person's Retry launch on an unconfirmed session: a new launch with new ids and a new token; the
   * old row becomes `superseded`, and a late registration of it is killed and logged (D21).
   */
  'sessions.retryLaunch': { params: { sessionId: string }; result: SessionStartResult };
  /** A person's Discard: revokes the unconfirmed row (C1 `discardLaunch`); the session goes `none`. */
  'sessions.discardLaunch': { params: { sessionId: string }; result: Empty };
  /**
   * In place: C1 `retire` (no exit), status stays `running`, restartSeq bumps; the remounted pane's
   * `sessions.start` is the spawn.
   */
  'sessions.restart': { params: { sessionId: string }; result: Reply<'agentScope:result'> };
  'sessions.relaunch': { params: { sessionIds: string[] }; result: { relaunched: string[] } };
  /** The same server-local close as C7 DomainPort.closeSession. */
  'sessions.remove': { params: { sessionId: string }; result: Empty };
  'sessions.duplicate': { params: { sessionId: string }; result: { sessionId: string } };
  'sessions.mutate': {
    params: { sessionId: string; mutation: SessionMutation };
    result: Reply<'session:opResult'>;
  };
  'sessions.reorder': { params: Msg<'reorderSessions'>; result: Empty };
  'sessions.addDirs': { params: Msg<'session:addDirsToAgent'>; result: Reply<'agentScope:result'> };
  'sessions.dismissScope': { params: Msg<'session:dismissAgentScope'>; result: Empty };
  'sessions.probeFolders': { params: Msg<'folder:probe'>; result: Reply<'folder:probeResult'> };

  // ── stores owned by the server ──
  'projects.create': { params: Msg<'project:create'>; result: Reply<'project:created'> };
  'projects.rename': { params: Msg<'project:rename'>; result: Reply<'project:opResult'> };
  'projects.delete': { params: Msg<'project:delete'>; result: Empty };
  'projects.reorder': { params: Msg<'project:reorder'>; result: Empty };
  'launchers.rescan': { params: Empty; result: Empty };
  'launchers.addCustom': { params: Msg<'launcher:addCustom'>; result: Reply<'launcher:added'> };
  'launchers.removeCustom': { params: Msg<'launcher:removeCustom'>; result: Empty };
  'launchers.preview': { params: Msg<'launch:preview'>; result: Reply<'launch:previewResult'> };
  'briefs.probe': { params: Msg<'brief:probe'>; result: Reply<'brief:probed'> };
  'briefs.agentPreview': {
    params: Msg<'brief:agentPreview'>;
    result: Reply<'brief:agentPreviewed'>;
  };
  'timers.set': { params: Msg<'timer:set'>; result: { error?: Reply<'timer:error'> } };
  'timers.offer': { params: Msg<'timer:offer'>; result: Empty };
  'timers.cancel': { params: Msg<'timer:cancel'>; result: Empty };
  'timers.renew': { params: Msg<'timer:renew'>; result: Empty };
  'timers.sendNow': { params: Msg<'timer:sendNow'>; result: Empty };
  'timers.sendOnce': { params: Msg<'timer:sendOnce'>; result: Empty };
  /** e2e-only clock seam; refused unless the server was started with --e2e. */
  'timers.test': { params: Msg<'timer:test'>; result: Empty };
  /**
   * From the renderer's key-scoped `updateServerSettings{patch}`, never from a whole-object
   * `updateSettings`, so a stale window can't revert another's change (D7). Coerced server-side; the
   * reply is the whole stored object.
   */
  'serverSettings.patch': {
    params: { patch: Partial<ServerSettings> };
    result: { settings: ServerSettings };
  };

  // ── UI facts from the app ──
  'ui.presence': { params: { windows: WindowPresence[] }; result: Empty };

  // ── MCP ──
  /** Renderer `mcp:*` messages tunnelled unchanged, with the sender window, checked for ask ownership. */
  'mcp.fromRenderer': {
    params: {
      windowId: number;
      message: Extract<WebviewToHost, { type: `mcp:${string}` }>;
    };
    result: { reply?: HostToWebview };
  };
  'mcp.installStatus': { params: { projectPath: string | null }; result: McpInstallStatus };
  'mcp.installAct': { params: { request: McpInstallRequest }; result: McpInstallResult };
}
export type ServerMethod = keyof ServerMethods;

/**
 * App → server notifications, no reply. The server's attach is the only active viewer (D19): it
 * applies the app's requested size, so PTY size = xterm size still holds, and every byte into a PTY
 * goes through its PtyWriter. They share the one ordered pipe, so a resize and facts sent before
 * `sessions.start` shape the first attach.
 */
export interface ServerNotifications {
  /**
   * Keystrokes, and xterm's own focus reports, the only focus producer as today: the server never
   * sends FOCUS frames. `onRendererInput` (typed tracker, draft state, attention) runs before the
   * write. While C2 is down the app drops them and shows input paused; a late keystroke could answer
   * a prompt (D29).
   */
  'term.input': { sessionId: string; generation: number; data: string };
  'term.resize': { sessionId: string } & TermGeometry;
  /**
   * From the renderer's `term:facts` (lead-owned, W7 implements). The server keeps the last per
   * session and passes it as `display` on every attach, so hc answers display queries.
   */
  'term.facts': { sessionId: string; facts: DisplayFacts };
  /**
   * The app's watcher lost or renamed a watched folder (today's SessionFolderRuntime `suspect`). The
   * health poll only rechecks folders already marked missing, so this is the only signal for a
   * healthy one. The server rechecks it only if `path` is one of that session's own folders (home or
   * a root), else ignores it. W7 sends it, W4 consumes it.
   */
  'folders.suspect': { sessionId: string; path: string };
}
export type ServerNotification = keyof ServerNotifications;

export interface ServerEvents {
  /**
   * Coalesced (≤ every 150 ms) full list; the session count is small enough that deltas don't pay.
   * The only source of session status: an observer link's CLOSE is never read as an exit.
   */
  'sessions.changed': { sessions: SessionView[] };
  /**
   * A created session to place: near the opener, focused or not. Sessions created with no app
   * running go to the focused (else first) window at launch.
   */
  'sessions.opened': { sessionId: string; openerSessionId?: string; focus: boolean };
  /**
   * Host-composed bytes for the pane (C7 ScrollbackPort.show), already in the ring. The app writes
   * them into the xterm the way it writes `prelude`; mid-stream ones come framed ESC7…ESC8.
   */
  'term.show': { sessionId: string; data: string };
  /**
   * A message for a renderer: mcp:state/ask/askClosed/ui/thread, openFileInEditor, activateSession.
   * `raise` brings the routed window to the front: today's focus_session raises only when the target
   * window differs from the caller's, and only the server knows both owners.
   */
  'ui.post': { route: UiRoute; message: HostToWebview; raise?: boolean };
  'approvals.changed': { pending: PendingAsk[] };
  /** The app decides whether to show an OS notification (D9). */
  'attention.edge': { sessionId: string; kind: 'run-end' | 'bell' | 'urgent-message' | 'ask' };
  'attention.flash': { sessionId: string };
  'serverSettings.changed': { settings: ServerSettings };
  'data.changed': { [K in DataStore]: { store: K; value: DataStores[K] } }[DataStore];
  'runtime.changed': RuntimeHealth;
  /**
   * One fire, with today's `timer:fired` payload, emitted before the coalesced `timers.changed`:
   * `timer:state` can't tell a fire from an edit, and the renderer's late/missed/failed toasts read
   * this pre-fire record.
   */
  'timers.fired': Reply<'timer:fired'>;
  'timers.changed': Reply<'timer:state'>;
  'server.stopping': { reason: 'update' | 'user' | 'idle' | 'stopAll' };
  /** The app fell behind; call events.subscribe again. */
  missed: { seq: number };
}
export type ServerEvent = keyof ServerEvents;

export interface ServerEventEnvelope<E extends ServerEvent = ServerEvent> {
  seq: number;
  type: E;
  data: ServerEvents[E];
}

/**
 * `server_stopping`: a `sessions.create` during the stopping transition (D32). Starts refuse in
 * SessionStartResult instead, MCP opens in their tool result (C7 DomainOpenOutcome). A stale
 * `term.input` generation is dropped silently, so no error kind exists for it.
 */
export type ServerErrorKind =
  | 'not_found'
  | 'conflict'
  | 'refused'
  | 'unavailable'
  | 'invalid'
  | 'server_stopping';

/**
 * Every server event travels as one JSON-RPC notification method, so a reader dispatches on
 * `params.type` and orders on `params.seq` without a method table per event.
 */
export const SERVER_EVENT_METHOD = 'event';
export interface ServerEventNotification<E extends ServerEvent = ServerEvent> {
  jsonrpc: '2.0';
  method: typeof SERVER_EVENT_METHOD;
  params: ServerEventEnvelope<E>;
}

/**
 * Domain refusals share one JSON-RPC code; the kind is in `data`. Parse/invalid-request/
 * method-not-found keep the standard JSON-RPC codes.
 */
export const SERVER_ERROR_RPC_CODE = -32000;
export interface ServerRpcError {
  code: typeof SERVER_ERROR_RPC_CODE;
  message: string;
  data: { kind: ServerErrorKind };
}

/**
 * The frozen calls' required field names; contracts.test.ts fails if they change within a
 * generation. Optional fields may be added beside them.
 */
export const FROZEN_SHAPES = {
  hello: {
    params: ['appVersion', 'generation'],
    result: ['serverVersion', 'generation', 'instance', 'pid'],
  },
  'server.restart': { params: ['reason'], result: [] },
  'server.stopAll': { params: [], result: ['killed'] },
} as const satisfies Partial<
  Record<ServerMethod, { params: readonly string[]; result: readonly string[] }>
>;
