// C4 — how a Conduit session is recognised across the server, hc and MCP.
// The token is the only identity an agent can present; labels only let the server find its terminals.
import type { AgentCli } from '../conduit-mcp/install-types';
import type { TermGeometry } from '../protocol';
import type { ReportedStatus } from './terminal-runtime';

export const SESSION_TOKEN_ENV = 'CONDUIT_SESSION_TOKEN';
export const MCP_ENDPOINT_ENV = 'CONDUIT_MCP_ENDPOINT';

/**
 * hc labels on every terminal the server spawns. Never trusted for identity: anyone can label. They
 * only narrow the subscription; adopt matches the address recorded in the token row (D21).
 */
export interface ConduitLabels {
  'conduit.session': string;
  /** userData hash; a dev build or an e2e run never adopts another instance's terminals. */
  'conduit.instance': string;
  /** Decimal generation, for logs and `hc ls`; adopt never reads it. */
  'conduit.generation': string;
  /**
   * TokenRecord.launchId, also the terminal's hc name. Logs and `hc ls` read it; a late confirmation
   * matches the name against an unconfirmed row, and adopt matches the recorded address (D21).
   */
  'conduit.launch': string;
  /**
   * `server` marks the supervisor's terminal for logs and so adopt, counts and orphan kills skip it.
   * Forgeable like every label: the start rule, the F6 wait and Restart identify the supervisor by its
   * unique hc name (InstanceNames.supervisorName) and the address hello reports, never by this.
   */
  'conduit.role'?: 'session' | 'server';
}

/**
 * One row of CLI_BINDINGS_FILE: the shell-CLI binding the host admitted from a typed command (D28).
 * Written at admission, deleted with the session or a new generation. On a resume with the same token
 * and generation, the first connection whose `initialize.clientInfo.name` equals `clientInfoName` is
 * rebound; every other client of that token stays secondary, as today.
 */
export interface CliBindingRecord {
  sessionId: string;
  generation: number;
  cli: AgentCli;
  clientInfoName: string;
}
/** Under userData/conduit-mcp, next to tokens.json. */
export const CLI_BINDINGS_FILE = 'bindings.json';

/**
 * A launch's reservation (D21). `reserved`: persisted before `terminal.run`, owned by this process's
 * in-flight spawn. `live`: the run reply or a later registration gave its address. `unconfirmed`: the
 * core connection was lost before the reply, or its process died mid-spawn; never set by a timeout.
 * A terminal registering later with its
 * launch id is adopted. `superseded`: a newer launch of the session replaced an unconfirmed one; if it
 * registers later it is killed and logged.
 */
export type TokenState = 'reserved' | 'live' | 'unconfirmed' | 'superseded';

/**
 * One row of `conduit-mcp/tokens.json`, owned by W5 alone behind C7 TokenStorePort. Only the hash is
 * stored (D15); the plaintext lives in the agent's environment. Written (atomically) as `reserved`
 * with `hcAddress: null` BEFORE `terminal.run`. Conduit records every outcome as soon as hc reports
 * it and never relies on hc keeping a record. Reconcile never revokes an `unconfirmed` or
 * `superseded` row: those go only by explicit discard, session removal, or once a superseded launch's
 * late terminal is killed. A `live` row goes when its exit is recorded or its session is removed.
 */
export interface TokenRecord {
  sessionId: string;
  sha256: string;
  generation: number;
  /**
   * Random uuid per launch as 32 lowercase hex, no hyphens: it is also the hc `name` (at most 32 of
   * a-z 0-9 - _ .) and the `conduit.launch` label.
   */
  launchId: string;
  state: TokenState;
  hcAddress: string | null;
  createdAt: string;
}

/**
 * Persisted on the server's session record in sessions.json (Session & PersistedLaunchCounter).
 * SessionStorePort.allocateLaunch reads and increments it, so a generation is never reused across
 * server restarts: the pane outlives the process and drops `term.input` only on a generation change.
 */
export interface PersistedLaunchCounter {
  /** 0 = never launched. */
  lastGeneration: number;
}

/** Runtime-only facts the server adds to a session; never persisted to sessions.json. */
export interface SessionRuntime {
  generation: number | null;
  /** `unconfirmed`: its launch's outcome is unknown; the app offers Retry launch and Discard (D21). */
  spawn: 'live' | 'unconfirmed' | 'none';
  /** The program's own OSC 7501 report, next to the heuristic busy/needsAttention. */
  reportedStatus: ReportedStatus;
  lastSize: TermGeometry | null;
}

/**
 * One userData → one instance → one server pipe (also its lock), MCP pipe, hc session and runtime
 * root. `<h>` = first 16 hex chars of sha256(win32 ? userData.toLowerCase() : userData), exactly as
 * src/conduit-mcp/endpoint-path.ts does today, so the MCP pipe of a v0.51 install doesn't move. Used
 * by both endpoints, HC_SESSION, uninstall and the CLI-entry migration.
 */
export interface InstanceNames {
  instance: string;
  /**
   * The server's single-instance lock. Windows: `\\.\pipe\conduit-server-<h>`; libuv binds the first
   * pipe instance, a second listen fails with EADDRINUSE and that server exits 0 (D17). A pipe dies
   * with its owner, so no stale lock or pid kill. POSIX (unit tests on ubuntu CI), mirroring
   * endpoint-path.ts: `<userData>/conduit-server.sock`, or `<tmpdir>/conduit-server-<h>.sock` past
   * the sun_path limit. A socket file outlives a crashed owner, so on POSIX only an EADDRINUSE whose
   * connect is refused unlinks the file and binds again.
   */
  serverEndpoint: string;
  mcpEndpoint: string;
  /**
   * `conduit-server-<h>` (31 chars, within hc's 32): the supervisor's unique hc terminal name. The
   * start rule, the F6 wait and Restart look it up by this name and check the address the server
   * reports in `hello.supervisor`; the forgeable `conduit.role=server` label decides nothing.
   */
  supervisorName: string;
  /**
   * `conduit-<h>`. Every hc call, the app's included, passes it explicitly with `HC_*` stripped from
   * the child env, and `hc run` adds `--no-parent`, so a Conduit launched from a Conduit or Herdr pane
   * never lands in, or is parented to, that pane's session (D16, M17).
   */
  hcSession: string;
  runtimeRoot: string;
  /** XDG_CONFIG_HOME / XDG_STATE_HOME for our core only: userData/hc/config and userData/hc/state (D24). */
  hcConfigHome: string;
  hcStateHome: string;
}

/** Write-once: never swapped. A new shim Node or protocol goes to a new dir (D2b). */
export const SHIM_RUNTIME_DIR = 'shim';

/** The supervisor alone restarts the server (D17); the app only starts one. */
export const SUPERVISOR_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const SUPERVISOR_GIVE_UP = { crashes: 5, windowMs: 10 * 60_000 } as const;
/**
 * An exhausted supervisor never exits for good: with no app open nothing else would ever restart the
 * bus. It cools down this long, then deletes the marker, resets its budget and tries again.
 */
export const SUPERVISOR_EXHAUSTED_COOLDOWN_MS = 30 * 60_000;
/** How often a cooling supervisor checks whether the app's Retry deleted the marker. */
export const SUPERVISOR_MARKER_POLL_MS = 5_000;

/**
 * The server's exit codes the supervisor reads. Any other code is a crash and is restarted. `done`:
 * don't restart, leave the core running. `doneCoreIdle`: don't restart, and no token row is
 * `reserved` or `unconfirmed`, so `hc server stop` may follow if no other terminal is live (D32).
 */
export const SERVER_EXIT = { done: 0, doneCoreIdle: 3 } as const;

/**
 * In userData, written atomically by a supervisor whose budget is spent, for the length of its
 * cooldown. While it exists the app starts no supervisor and shows `server: unavailable`; its Retry
 * deletes it, which ends a live supervisor's cooldown at the next poll, or lets the start rule run.
 */
export const SERVER_EXHAUSTED_FILE = 'server-exhausted.json';
export interface ServerExhaustion {
  /** ISO time. */
  at: string;
  /** ISO time the cooldown ends. */
  retryAt: string;
  lastExitCode: number | null;
  logPath: string;
}

/**
 * Every versioned format the server owns, with the version this build writes, in the format's own
 * existing field: `version` at the top of each JSON file, `v` on each `messages.log` record, so there
 * is no second version mechanism. The fourth cross-version edge (D12): an older server must not
 * misread or overwrite what a newer one wrote. The architecture's §Persisted formats lists these and
 * the unversioned exceptions. Readers ignore fields they don't know.
 */
export const SERVER_FILE_VERSION = {
  'sessions.json': 1,
  'server-settings.json': 1,
  'projects.json': 1,
  'launchers.json': 1,
  'timed-messages.json': 1,
  'conduit-mcp/tokens.json': 1,
  'conduit-mcp/bindings.json': 1,
  'conduit-mcp/messages.log': 1,
  'scrollback-<id>.json': 2,
  'server-exhausted.json': 1,
} as const;
export type ServerFile = keyof typeof SERVER_FILE_VERSION;

/**
 * `read`: this version or an older one the reader still parses. `newer`: written by a newer server;
 * the caller treats the file as unreadable for this run and never overwrites it (a token store goes
 * degraded, D21). `invalid`: no usable version, so the format's own corrupt rule applies.
 */
export function judgePersistedVersion(
  file: ServerFile,
  found: unknown,
): 'read' | 'newer' | 'invalid' {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) return 'invalid';
  return found > SERVER_FILE_VERSION[file] ? 'newer' : 'read';
}

/**
 * The user's own XDG values, captured when the core is started and passed through to the server, so
 * session specs restore them (D24). Under isolation, a variable the user has unset is captured as
 * `""`, not left absent: terminal.run.env can only set, never unset, and the XDG base-dir spec treats
 * empty as unset (M22).
 */
export const USER_XDG_PASSTHROUGH = {
  XDG_CONFIG_HOME: 'CONDUIT_USER_XDG_CONFIG_HOME',
  XDG_STATE_HOME: 'CONDUIT_USER_XDG_STATE_HOME',
} as const;
/**
 * Set once the originals were captured. A process already under our core (the server) sees our
 * isolated XDG values, so without it a user with no XDG set would get ours passed through.
 */
export const USER_XDG_CAPTURED_ENV = 'CONDUIT_USER_XDG_CAPTURED';

/** `hc run` flags for the supervisor start, from the app or from the server alike (D16, M17). */
export const CORE_START_RUN_FLAGS = ['--bg', '--no-parent'] as const;

/**
 * The one env builder for every process that may start our core: the app's supervisor start and the
 * server's own hc client. Two builders drifted before (the app skipped XDG isolation, and nothing
 * captured the user's originals). HC_* is stripped case-insensitively, since Windows env names are;
 * `isolateXdg` is false when M22 fails, and then our core shares the user's hc config (D24).
 */
export function coreStartEnv(
  parent: Readonly<Record<string, string | undefined>>,
  names: Pick<InstanceNames, 'hcSession' | 'hcConfigHome' | 'hcStateHome'>,
  isolateXdg: boolean,
): Record<string, string> {
  const env: Record<string, string> = {};
  const byUpper = new Map<string, string>();
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (upper.startsWith('HC_')) continue;
    byUpper.set(upper, v);
    if (upper !== USER_XDG_CAPTURED_ENV) env[k] = v;
  }
  const captured = byUpper.has(USER_XDG_CAPTURED_ENV);
  for (const [xdg, passthrough] of Object.entries(USER_XDG_PASSTHROUGH)) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === passthrough) delete env[k];
    const original = byUpper.get(captured ? passthrough : xdg);
    if (original !== undefined) env[passthrough] = original;
    else if (isolateXdg) env[passthrough] = '';
  }
  env[USER_XDG_CAPTURED_ENV] = '1';
  if (isolateXdg) {
    for (const k of Object.keys(env)) if (k.toUpperCase() in USER_XDG_PASSTHROUGH) delete env[k];
    env.XDG_CONFIG_HOME = names.hcConfigHome;
    env.XDG_STATE_HOME = names.hcStateHome;
  }
  env.HC_SESSION = names.hcSession;
  return env;
}
