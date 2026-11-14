// C1 — what the server's domain code (MCP host, attention, timers, sessions) needs from terminals.
// One implementation over hc (C3); a fake in unit tests. The server is each live session's only
// active viewer and only writer (D19); the app only observes (C5).
import type { ScreenSnapshot } from '../conduit-mcp/screen-verdict';
import type { TermGeometry } from '../protocol';
import type { SpawnSpec } from '../types';
import type { DisplayFacts } from './frames';
import type { ConduitLabels } from './session-identity';
import type { AttachTarget } from './terminal-link';

/** Program-reported status (OSC 7501). `null` = the program never reported. */
export type ReportedStatus =
  | { state: 'idle' | 'working' | 'done' | 'error'; app?: string; progress?: number | null }
  | { state: 'blocked'; kind: 'permission' | 'question' | 'auth' | null; app?: string }
  | null;

/**
 * History lines the server's active attach asks for on a re-attach, capped by the 256 KiB ring (D18).
 * A re-attach (server restart, core reconnect) passes the hc record's current cols/rows and
 * `resumed: true`, so a reconnect never resizes a PTY.
 */
export const SERVER_REATTACH_HISTORY_LINES = 2000;

/**
 * Past this much unparsed output for one session the screen model is discarded and reads as unknown:
 * a month-long daemon can't let a stalled parse grow without bound (D18). Credit is granted on ring
 * append, so no hc gap paint follows by itself; once the backlog drains, W6 drops its active attach
 * and attaches again, and that `paint{cause:'attach'}` reseeds the model (F8). The ring is unaffected.
 */
export const SCREEN_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Both allocated by W4 through C7 SessionStorePort, the single producer, and passed explicitly to
 * LaunchPort.prepareLaunch and spawn(); W6 never derives either from labels.
 */
export interface LaunchIds {
  generation: number;
  /** 32 lowercase hex: the hc `name`, the `conduit.launch` label and the token row's key (D21). */
  launchId: string;
}

export interface RuntimeTerminal {
  sessionId: string;
  /** Bumps on every spawn of the same session; writes carrying an older generation are dropped. */
  generation: number;
  launchId: string;
  /** `finished` only for an adopted record; a spawn that ended before its attach is SpawnFinished. */
  state: 'live' | 'finished';
  size: TermGeometry;
  target: AttachTarget;
}

export interface AdoptedTerminal extends RuntimeTerminal {
  labels: ConduitLabels;
}

/**
 * The core connection dropped with the `terminal.run` reply outstanding. A spawn resolves on hc's
 * reply or on connection loss, never on a clock: a timeout would manufacture this state for a run
 * that is merely slow. The token row stays `unconfirmed`: never retried, never revoked because hc
 * doesn't list it (pinned v0.1.16 registers a run only after holder and env preparation). A terminal
 * that later registers with this launch id is adopted; otherwise a person retries or discards it, and
 * an MCP caller gets this as its result and may request a new launch (D21).
 */
export interface SpawnUnconfirmed {
  reason: 'spawn_unconfirmed';
  launchId: string;
}

/** The server is stopping (D32): no launch starts, from C2, MCP or a timer alike. */
export interface ServerStopping {
  reason: 'server_stopping';
}

export type RuntimeExitReason = 'exited' | 'killed' | 'lost';

/**
 * The program ended before the server's active attach (hc attaches only to live terminals). Its final
 * output was read with `terminal.read` into the ring and its exit recorded at once, so nothing waits
 * on hc keeping the record.
 */
export interface SpawnFinished {
  exitCode: number | null;
  reason: RuntimeExitReason;
  /** The program's final output (`terminal.read`), already in the ring; the domain adds it to the prelude. */
  output: string;
}

export type SpawnResult =
  | { ok: true; terminal: RuntimeTerminal }
  | { ok: true; launchId: string; finished: SpawnFinished }
  | { ok: false; refusal: SpawnUnconfirmed | ServerStopping | SpawnFailed };

/** hc refused the run itself (e.g. `spawn_failed`: the program can't start); its row is revoked. */
export interface SpawnFailed {
  reason: 'spawn_failed';
  message: string;
}

/**
 * Where an attach paint ends (D20, until hc marks it): the bytes until the stream has been quiet for
 * PAINT_QUIET_MS, capped at PAINT_MAX_MS from the moment the attach is held (so a paint with no bytes still ends). The server's C1 `paint` and the app's
 * C5 `FirstPaint` use the same rule, so neither reads a paint's tail as activity.
 */
export const PAINT_QUIET_MS = 30;
export const PAINT_MAX_MS = 1_000;

/**
 * The stopping transition's bound on in-flight launches (D32). Past it, `server.restart` leaves them
 * `unconfirmed` for the replacement to adopt; `server.stopAll` marks them `superseded`, so a late
 * registration is killed rather than adopted.
 */
export const LAUNCH_SETTLE_ON_STOP_MS = 10_000;

export type RuntimeEvent =
  /**
   * The active attach is held: spawn, adopt, or a late-confirmed launch. Replaces the host's onSpawn:
   * W5 resets its per-spawn state and calls ScreenPort.ensure or keepTail.
   */
  | { type: 'spawned'; sessionId: string; generation: number; size: TermGeometry }
  /** A launch's outcome became unknown; W4 shows Retry launch / Discard (D21). */
  | { type: 'unconfirmed'; sessionId: string; generation: number; launchId: string }
  /**
   * Output the program wrote. Exactly one subscriber per concern (§Internal subscribers): W6 inside
   * the runtime (ring, screen model, activity and attention incl. bells and the inert scan); W4 on
   * this event (lastLine from tailLines, the Limit monitor scan, bracketed-paste tracking, scopes).
   */
  | { type: 'data'; sessionId: string; generation: number; data: string }
  /**
   * A synthetic full screen from hc on the server's active attach. Never activity or attention.
   * `attach`: the first attach after spawn or adopt; the ring keeps its content. `gap`: a re-attach
   * after a core reconnect or a server restart, or the repaint replacing a backlog >4 MiB behind;
   * output may be missing, so the ring appends a gap marker and the paint as a new segment, and never
   * resets (D18, D20). Resizes never re-attach.
   */
  | {
      type: 'paint';
      sessionId: string;
      generation: number;
      data: string;
      size: TermGeometry;
      cause: 'attach' | 'gap';
    }
  | {
      type: 'exit';
      sessionId: string;
      generation: number;
      code: number | null;
      reason: RuntimeExitReason;
    }
  /** OSC 7501, the primary attention source wherever the program reports (D34). */
  | { type: 'status'; sessionId: string; status: ReportedStatus }
  /** The only title source (N1). */
  | { type: 'title'; sessionId: string; title: string }
  | { type: 'size'; sessionId: string; size: TermGeometry }
  /**
   * hc's `foreground` (~2/s). Unused by Conduit: on Windows it reports only the terminal's root
   * process (M27 failed). The live cwd comes from the ported CwdScanner on `data` (W4), the typed CLI
   * from detectTyped on `term.input` (W5); D38. Kept because hc emits it. Null once the program finished.
   */
  | { type: 'foreground'; sessionId: string; foreground: RuntimeForeground | null }
  /** The core connection came back and reconcile() ran; events in between may be missing (D22). */
  | { type: 'resynced' };

/** hc's `Foreground` record, verbatim. */
export interface RuntimeForeground {
  pid: number;
  name: string;
  argv: string[];
  cwd: string;
}

export interface TerminalRuntime {
  /**
   * Startup and every core reconnect (D21, D22). The hc subscription is already open, so a launch
   * that registers at any later time arrives as a `created` event and is adopted (late confirmation).
   * Absence never resolves a launch. In order:
   * 1. Read the rows through C7 TokenStorePort, never the file. Unreadable, or missing while labelled
   *    terminals live: health becomes `degraded: 'token store unreadable'`; adopt nothing, kill nothing.
   * 2. Skip every row an in-flight spawn in this process owns.
   * 3. `live` rows: `terminal.get` by hcAddress. Live: adopt by (hcAddress, launchId), active-attaching
   *    at the record's size with `resumed`. Finished: skip the attach (hc refuses it with `finished`),
   *    take `exit_code`/`reason`, `terminal.read` the final output into the ring, emit `exit`, then
   *    `terminal.rm`. `not_found` only: the record was pruned (after a day or past 500; nothing
   *    survives a reboot): `exit` `lost`, revoke.
   * 4. `reserved` rows (their process died mid-spawn) and `unconfirmed` rows: `terminal.get` with the
   *    launch id as the name. Found: resolveAddress and adopt as in 3. Not found: the row stays
   *    `unconfirmed` (a `reserved` one becomes it) and `unconfirmed` is emitted for every such row,
   *    so a restarted server's domain can offer Retry launch / Discard for it.
   * 5. `superseded` rows: a terminal by that name is killed if live, logged, and its row revoked; not
   *    found, the row stays.
   * 6. Only after a clean load: kill `conduit.role=session` terminals that match no row. Never the
   *    supervisor's `conduit.role=server` terminal.
   * Between reconciles the same rule holds per hc `created` event: after a clean load, a
   * `conduit.role=session` terminal whose launch id matches no row is killed at once (a discarded
   * launch, or an agent's own labelled `hc run`).
   */
  reconcile(): Promise<AdoptedTerminal[]>;
  /**
   * The caller passes the ids it allocated and the spec LaunchPort.prepareLaunch built, whose token
   * row is already `reserved`. Runs with `name: launchId`, then:
   * - Reply: resolveAddress (row `live`) and take the active attach at the session's last requested
   *   size (else hc's default) with its last facts as `display`, held until exit.
   * - The program ended before that attach: read its final output (`terminal.read`) into the ring,
   *   record the exit at once, return `finished`.
   * - Core connection lost before the reply: markUnconfirmed, emit `unconfirmed`, return
   *   SpawnUnconfirmed. No timer resolves a spawn. Never retried by name and never
   *   listed-then-retried (D21).
   * - Stopping: ServerStopping, before any run.
   * One start in flight per session; the caller dedupes concurrent starts.
   * The run env sets `TERM_PROGRAM=conduit` and `TERM_PROGRAM_VERSION=<app version>`: hc otherwise
   * defaults to ghostty and answers XTVERSION with it (M10).
   */
  spawn(
    sessionId: string,
    spec: SpawnSpec,
    labels: ConduitLabels,
    ids: LaunchIds,
  ): Promise<SpawnResult>;
  /**
   * A person's Discard of the session's unconfirmed launch (C2 `sessions.discardLaunch`): revokes its
   * row. A terminal registering later matches no row and is killed on its `created` event.
   */
  discardLaunch(sessionId: string, launchId: string): Promise<void>;
  /**
   * Enters the server's stopping state (D32): later spawns return ServerStopping. Resolves once every
   * in-flight spawn resolved or LAUNCH_SETTLE_ON_STOP_MS passed. Still pending then: `restart` marks
   * them `unconfirmed` (the replacement adopts them), `stopAll` marks them, and every `unconfirmed`
   * row left from an earlier restart, `superseded` (a late registration is killed, never adopted).
   */
  beginStopping(mode: 'restart' | 'stopAll'): Promise<void>;
  /**
   * One raw write on the active attach; false when not live or `generation` is stale. The only path
   * into a PTY: the server's PtyWriter (TypingPort) is built over it. hc `terminal.send` is never
   * used: it is atomic behind its own quiet gate, so it can't host the Enter recheck. xterm's own
   * focus reports arrive here too, the only focus producer, as today.
   */
  input(sessionId: string, generation: number, data: string): boolean;
  /**
   * The app's requested size (`term.resize`); kept as the last size while no app is attached. Bytes
   * already in flight for the old grid still reach the new one, exactly as with node-pty; ConPTY's
   * post-resize repaint corrects both screen models (D31, M19).
   */
  resize(sessionId: string, size: TermGeometry): void;
  /**
   * The renderer's display facts (`term.facts`, sent before `sessions.start` like a resize). Kept per
   * session and passed as `display` on every attach, windowless spawns included with the last known
   * facts or none.
   */
  facts(sessionId: string, facts: DisplayFacts): void;
  get(sessionId: string): RuntimeTerminal | undefined;
  /**
   * Screen model for the notice gate (W5 reads, W6 owns; ScreenPort starts it). Fed off the ring
   * append and coalesced, so a slow parse never holds back hc credit (D20). Resolves only after every
   * `data` received before the call has been parsed: beforeEnter's echo recheck reads it. Null while
   * no model runs or it is unknown: a backlog past SCREEN_BACKLOG_MAX_BYTES discards it until the next
   * `paint`, and the notice gate fails closed meanwhile (F8).
   */
  screen(sessionId: string): Promise<ScreenSnapshot | null>;
  /** Last ≤4 KiB of output as lines; W4 reads it on `data` for lastLine. */
  tailLines(sessionId: string, n: number): string[];
  /** Kill; the matching `exit` event is still emitted. */
  kill(sessionId: string): Promise<void>;
  /**
   * Kill for an in-place restart (`sessions.restart`): no `exit` event for this generation, status
   * stays `running`, restartSeq bumps, and the remounted pane's `sessions.start` is the spawn. The
   * app observer's CLOSE on the old link is not an exit: status comes only from `sessions.changed`.
   */
  retire(sessionId: string): Promise<void>;
  /** Detach from every terminal and close the connection. Terminals keep running. */
  close(): Promise<void>;
  /** All events, in order per session. Returns an unsubscribe function. */
  on(listener: (e: RuntimeEvent) => void): () => void;
}
