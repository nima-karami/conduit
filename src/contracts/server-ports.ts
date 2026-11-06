// C7 — the server's internal seams, so W4, W5 and W6 can build in parallel. Lead-owned; wired only in
// server/compose.ts (also lead-owned), which also forwards AttentionPort.onEdge to C2 `attention.edge`
// and merges AttentionPort.statusOf into every `sessions.changed`.
// Derived from electron/conduit-mcp-host.ts ConduitMcpHostDeps: each port is the narrow slice one lane
// provides and another consumes. W0b refactors the host onto these on main first, so W5 imports it
// instead of copying it (D27). No port calls back into its caller: TypingPort is a plain writer, so W6
// never reaches W5's draft tracker (F8).
import type { ControlDeps, McpOpenRequest } from '../conduit-mcp/control-tools';
import type { AgentCli, UserInstallState } from '../conduit-mcp/install-types';
import type { CliPolicyLayers, GlobalPolicy } from '../conduit-mcp/tool-policy';
import type { PtyWriter } from '../pty-writer';
import type { ActivitySnapshot, SessionActivity } from '../session-activity';
import type { SessionManager } from '../session-manager';
import type { AgentDefinition, SessionAttentionFacts, SessionOpener, SpawnSpec } from '../types';
import type { ServerEvent, ServerEvents } from './server-protocol';
import type { TokenRecord } from './session-identity';
import type { FirstPaint } from './terminal-link';
import type { LaunchIds, TerminalRuntime } from './terminal-runtime';

/**
 * W4 provides: the session records the MCP host and attention read and touch, and the single
 * producer of launch ids.
 */
export type SessionStorePort = Pick<
  SessionManager,
  'get' | 'list' | 'setMcp' | 'setMcpToolPolicy' | 'touch' | 'setStatus' | 'onChange'
> & {
  /**
   * Reads the session record's persisted `lastGeneration` (sessions.json, C4 PersistedLaunchCounter),
   * increments and persists it, and returns it with a fresh launch id. The counter lives on the
   * record because a token row is revoked when its exit is recorded while the pane outlives the
   * process: a counter restarting at 1 would deliver a previous life's in-flight input.
   */
  allocateLaunch(sessionId: string): LaunchIds;
};

/**
 * The MCP open's outcome, frozen here for W4 (producer) and the W0b control tools (consumer). Today's
 * McpOpenOutcome plus the two launch failures D21/D32 add. W0b makes McpOpenOutcome
 * (src/conduit-mcp/control-tools.ts) equal to this, adds both codes to ToolErrorCode and an optional
 * structured `sessionId` to ToolError (src/conduit-mcp/types.ts), and maps them in the open handler
 * with tests, on `main` before W5. This is MCP's tool-result envelope, not C2: `sessions.create`
 * refuses as an RPC error, `sessions.start` in its result.
 */
export type DomainOpenOutcome =
  | { ok: true; sessionId: string; label: string }
  | { ok: false; code: 'unknown_agent' | 'brief_unavailable'; message: string }
  /**
   * Created, but its launch is unconfirmed (C1 SpawnUnconfirmed). The caller gets `sessionId` as a
   * structured field of the tool error, so it can `close_session` it before opening another (F3).
   */
  | { ok: false; code: 'spawn_unconfirmed'; message: string; sessionId: string }
  /** The stopping transition (D32): nothing was created. */
  | { ok: false; code: 'server_stopping'; message: string };
export type DomainOpenFailureCode = Extract<DomainOpenOutcome, { ok: false }>['code'];

/**
 * The tool errors W0b's handler maps the two launch failures to. `spawn_unconfirmed` is not
 * retryable (the caller closes the session first); `server_stopping` is, since a restart's
 * replacement serves the retry.
 */
export type McpLaunchToolError =
  | { code: 'spawn_unconfirmed'; message: string; retryable: false; sessionId: string }
  | { code: 'server_stopping'; message: string; retryable: true };

export interface CloseSessionOptions {
  /** For the log: the MCP caller, or absent for a person's close from the app. */
  closedBy?: SessionOpener;
}

/**
 * W4 provides: what ConduitMcpHostDeps.control and the registry/settings reads need. The rest of
 * ControlDeps is W5's own: claimHandle, now, info and targets; ownerWindowOf and windowReady from its
 * presence mirror; activateSession and openFile as `ui.post` to the owner window.
 */
export interface DomainPort
  extends Pick<
    ControlDeps,
    | 'homeOf'
    | 'resolvePath'
    | 'kindOf'
    | 'agentIds'
    | 'resolveCommand'
    | 'foldersOf'
    | 'addRoot'
    | 'git'
  > {
  openSession(req: McpOpenRequest): Promise<DomainOpenOutcome>;
  /**
   * The server-local close, shared with C2 `sessions.remove`: kills or retires the terminal
   * (discarding an unconfirmed launch, whose late registration is then killed), revokes its tokens
   * through LaunchPort.onSessionDeleted, and removes the session. No dirty-buffer check: editor
   * buffers live only in an open app. W0b's `close_session` handler calls it when the target's owner
   * window isn't ready; with a ready one it keeps today's renderer close and dirty check (F3).
   */
  closeSession(
    sessionId: string,
    opts: CloseSessionOptions,
  ): Promise<{ ok: true } | { ok: false; code: 'unknown_session'; message: string }>;
  /** effectiveDef(session, registry). */
  defOf(sessionId: string): AgentDefinition | undefined;
  /** The registry's definition for an agent id; open_session's model check reads its adapter. */
  agentDef(agentId: string): AgentDefinition | undefined;
  projectName(projectId: string | undefined): string | null;
  /** The CLI's user-scope install state, shown with a not-connected session. */
  installState(cli: AgentCli): UserInstallState;
  messagingOn(): boolean;
  /** ServerSettings.mcpToolPolicy and mcpToolPolicyByCli, read per call. */
  toolPolicy(): { global: GlobalPolicy; byCli: CliPolicyLayers };
}

/**
 * W5 provides, W4 consumes: the host's launch seam (`conduit-mcp-host.ts` prepareLaunch,
 * whenLaunchReady, onSessionDeleted), which W0b makes async on main. W4 allocates the ids and passes
 * them here and then to C1 spawn; it never calls TokenStorePort itself.
 */
export interface LaunchPort {
  /** Today's wait for the MCP endpoint, so a launch restored at start isn't wired tokenless. */
  whenLaunchReady(): Promise<void>;
  /**
   * Resets the session's per-launch host state, reserves its token row through TokenStorePort, and
   * returns the spec with the MCP env and argv injected.
   */
  prepareLaunch(
    sessionId: string,
    def: AgentDefinition,
    spec: SpawnSpec,
    ids: LaunchIds,
  ): Promise<SpawnSpec>;
  onSessionDeleted(sessionId: string): Promise<void>;
}

export type AttentionEdge = ServerEvents['attention.edge'];

/**
 * W6 provides, all of attention included. Input never acknowledges an episode (v0.51: only
 * visibility did), so W5 reports input and W6 records it without clearing. Output comes from W6's own active stream (bells, the inert scan), so no caller
 * records it. Visibility acknowledges watched sessions and suppresses episodes, so W5 forwards every
 * `ui.presence` here and calls `clearAll` when the app disconnects: no window is watching then. A
 * program's OSC 7501 report outranks the output heuristics wherever it reports (D34). Activity and
 * attention only: the limit-notice scan is W4's.
 */
/** The legacy flags plus the new Needs-you reason and completion counter. */
export type ServerAttentionSnapshot = ActivitySnapshot & SessionAttentionFacts;

export interface AttentionPort
  extends Pick<SessionActivity, 'lastOutputAt' | 'setVisible' | 'dropWindow'> {
  statusOf(sessionId: string): ServerAttentionSnapshot;
  recordInput(sessionId: string, now: number): void;
  clearAll(): void;
  onEdge(listener: (edge: AttentionEdge) => void): () => void;
  /** Any statusOf field changed for some session: compose re-sends `sessions.changed`. */
  onChange(listener: () => void): () => void;
}

/**
 * W5 provides, for W4's `runAddDir`, which calls it before its TypingPort write as main.ts:3019 does
 * today: a host paste the human still has to submit counts as a draft and withholds a notice's
 * in-flight Enter (F8).
 */
export interface DraftPort {
  noteHostInput(sessionId: string, data: string): void;
}

/** What W4 reads of attention: runAddDir's not-busy gate. W4 never feeds attention. */
export type AttentionStatusRead = Pick<AttentionPort, 'statusOf'>;

export interface TypingWriteOptions {
  /** A stale generation drops the write. */
  generation?: number;
}

/**
 * W6 provides, over C1 `input`: today's src/pty-writer.ts, unchanged, and a plain writer: callers do
 * their own bookkeeping first, so W6 never calls back into W5. Notices pass the queue-slot gate as
 * hooks, timed messages submit bare, add-dir and keystrokes write.
 */
export interface TypingPort {
  submit: PtyWriter['submit'];
  /** One raw write, not queued behind a submit's gap, as today. */
  write(sessionId: string, data: string, opts?: TypingWriteOptions): boolean;
  submitEnter: PtyWriter['submitEnter'];
  forget: PtyWriter['forget'];
}

/**
 * W6 provides, W5 calls: the screen model's lifecycle. A model costs memory, so one starts only once
 * a CLI shows up (D6 ruling): on `spawned` for a session with a defined adapter, else on the first CLI
 * `initialize`. Feeding and resizing stay inside W6.
 */
export interface ScreenPort {
  /**
   * Starts the model if none runs. `seedTail`: seed it from the kept tail, since a CLI paints its UI
   * before it initializes and never fully repaints.
   */
  ensure(sessionId: string, opts: { seedTail: boolean }): void;
  /** A tracked shell's tail is kept from spawn, so a later `ensure` can seed from it. */
  keepTail(sessionId: string): void;
  /** On exit and deletion. */
  release(sessionId: string): void;
}

/**
 * W6 provides, W4 consumes: `sessions.start` takes its `prelude` from here, host-composed bytes go
 * through `show`, and W6 alone touches the ring and its files.
 */
export interface ScrollbackPort {
  /**
   * Today's ScrollbackStore.replayForColdStart: this server run's ring when it has one, else the one
   * on disk; the replay's tail is recorded too, since the terminal is shown it. Null = no history.
   */
  replayForColdStart(sessionId: string): FirstPaint | null;
  /**
   * For a `mode: 'view'` start of a session that isn't live: the same neutralized replay, recording
   * nothing — no child continues that stream, so the ring stays what a later cold start replays.
   */
  replayForView(sessionId: string): FirstPaint | null;
  /**
   * For a start that finds the session already live: the ring recorded before its current launch
   * (earlier runs, relaunch markers, host-composed lines), run by run and recording nothing. The
   * observer's hc history covers the live launch itself. Null = nothing before it.
   */
  replayBeforeLaunch(sessionId: string): FirstPaint | null;
  /**
   * Today's ScrollbackStore.show, for host-composed bytes that are not PTY output: the relaunch
   * marker, ConPTY replay padding, role-brief banners, can't-start lines and the refusal text of a
   * start that never spawns. Emitted as C2 `term.show` and appended to the ring at the session's
   * current size: the ring must hold exactly what the pane was shown, or a later cold replay drifts.
   * Never through TypingPort, which would type them into the program.
   */
  show(sessionId: string, data: string): void;
  /**
   * Appends host-composed bytes to the ring at the session's current size WITHOUT `term.show`: for
   * bytes the app writes itself as part of a start's `prelude` (the relaunch marker, ConPTY padding),
   * which must be in the ring before the program's first output.
   */
  record(sessionId: string, data: string): void;
  forget(sessionId: string): void;
}

/** `missing` with labelled terminals live is as bad as `unreadable` (C1 `reconcile`, D21). */
export type TokenRows =
  | { state: 'loaded'; rows: readonly TokenRecord[] }
  | { state: 'missing' }
  | { state: 'unreadable' };

/**
 * W5 provides and is the sole owner of conduit-mcp/tokens.json. `reserve` is W5-internal, called from
 * LaunchPort.prepareLaunch; W6's spawn and reconcile use the rest and never the file. W0b introduces
 * it in the host over today's in-memory registry, so the persistent implementation is W5's alone.
 */
export interface TokenStorePort {
  /**
   * Mints the token and persists the row as `reserved` (`hcAddress: null`) before any run. The
   * session's earlier row is revoked, as today, unless it is `unconfirmed`: then it becomes
   * `superseded` (D21).
   */
  reserve(sessionId: string, ids: LaunchIds): Promise<{ token: string }>;
  /** The reply or a late registration: the row becomes `live`. */
  resolveAddress(launchId: string, hcAddress: string): Promise<void>;
  /** Connection loss mid-spawn, or `server.restart`'s settle bound (D32). */
  markUnconfirmed(launchId: string): Promise<void>;
  /** `server.stopAll`'s settle bound: a late registration is then killed, never adopted (D32). */
  markSuperseded(launchId: string): Promise<void>;
  /**
   * Also the busy check: idle exit and `hc server stop` wait while any row is `reserved` or
   * `unconfirmed`, since such a run may still register (D32).
   */
  rows(): TokenRows;
  /** By session: every row of it, whatever its state. By launch id: that row. */
  revoke(key: { sessionId: string } | { launchId: string }): Promise<void>;
}

export type ServerEventSink = <E extends ServerEvent>(type: E, data: ServerEvents[E]) => void;

/**
 * What W5's MCP host gets in place of ConduitMcpHostDeps' mgr, activity, writer, pty, screens, the
 * domain reads and the send/broadcast/flash callbacks. Paths and flags stay plain values wired in
 * server/compose.ts. The presence mirror behind ownerWindowOf/windowReady is W5's own, keyed by C2
 * connection with window ids namespaced per connection. It is the host's only window-event carrier:
 * onSessionMoved fires when a session's owning window changes, onWindowReset when a window disappears
 * or goes `ready: false` (F7). The host never writes raw input: every byte goes through `typing`. `spawned`, `size`
 * and `exit` on `runtime.on` replace today's onSpawn, onResize and onExit; the revoke, connection
 * close and removeConfig on exit stay in the host.
 */
export interface McpHostDeps {
  sessions: SessionStorePort;
  domain: DomainPort;
  attention: AttentionPort;
  typing: TypingPort;
  screens: ScreenPort;
  tokens: TokenStorePort;
  runtime: Pick<TerminalRuntime, 'get' | 'screen' | 'on'>;
  emit: ServerEventSink;
}
