import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, promises as fsp, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { join, resolve } from 'node:path';
import { watchDir, watchDirWhilePresent } from '../../electron/watch-dir';
import { runAddDir } from '../../src/add-dir-delivery';
import { AgentRegistry } from '../../src/agent-registry';
import { scopeFromSpawnArgs } from '../../src/agent-scope';
import { AgentScopeTracker } from '../../src/agent-scope-tracker';
import { atomicWriteFile, atomicWriteFileSync } from '../../src/atomic-write';
import { claudeSettingsFileOf } from '../../src/claude-hook-settings';
import { claudeSignalsFromHook } from '../../src/claude-signals';
import { adapterFor } from '../../src/conduit-mcp/adapters';
import type { McpOpenRequest } from '../../src/conduit-mcp/control-tools';
import { CLI_KINDS, type CliKind } from '../../src/conduit-mcp/tool-policy';
import { type AgentsConfig, loadAgentsConfig, readBlob, readFileState } from '../../src/config';
import type { HookPost } from '../../src/contracts/hook-protocol';
import type { SessionAutoResume } from '../../src/contracts/scheduler';
import type {
  AttentionStatusRead,
  DomainOpenOutcome,
  DomainPort,
  DraftPort,
  LaunchPort,
  ScrollbackPort,
  ServerEventSink,
  SessionStorePort,
  TypingPort,
} from '../../src/contracts/server-ports';
import {
  APP_SESSION_FIELDS,
  type AppSessionField,
  type ServerMethod,
  type ServerMethods,
  type ServerSettings,
  type ServerSnapshot,
  type SessionMutation,
  type SessionStartResult,
  type SessionView,
  type WindowPresence,
} from '../../src/contracts/server-protocol';
import {
  type ConduitLabels,
  type PersistedLaunchCounter,
  type SessionRuntime,
  USER_XDG_CAPTURED_ENV,
  USER_XDG_PASSTHROUGH,
} from '../../src/contracts/session-identity';
import type { FirstPaint } from '../../src/contracts/terminal-link';
import type {
  AdoptedTerminal,
  LaunchIds,
  RuntimeEvent,
  TerminalRuntime,
} from '../../src/contracts/terminal-runtime';
import { createCwdReportGate } from '../../src/cwd-report-gate';
import { cwdReportingAugmentation } from '../../src/cwd-reporting';
import { folderKey } from '../../src/folder-key';
import { probeFolders } from '../../src/folder-probe';
import { type DroppedRoot, type FolderProbeDeps, probeFolder } from '../../src/folder-validation';
import { GIT_TIMEOUT, runGit } from '../../src/git-exec';
import { getGitInfo } from '../../src/git-info';
import { lastNonEmptyLine } from '../../src/last-line';
import { previewLaunch } from '../../src/launch-preview';
import { buildLaunchSpec, sanitizeChildEnv } from '../../src/launch-spec';
import { LauncherHost } from '../../src/launcher-host';
import type { LauncherKind } from '../../src/launchers';
import { matchLimitRules } from '../../src/limit-rules';
import type { HostPlatform } from '../../src/lsp-binary';
import { deliverableText, normalizeMessage } from '../../src/message-text';
import { CwdScanner } from '../../src/osc-cwd';
import { userRootsOf } from '../../src/path-link-roots';
import { parseSessions, serializeSessions } from '../../src/persistence';
import { ProjectStore, parseProjects, serializeProjects } from '../../src/project-store';
import type { TermGeometry } from '../../src/protocol';
import { briefKeepIds, createRoleBriefHost, parseBriefRequest } from '../../src/role-brief-host';
import { Scheduler, toTimedMessage } from '../../src/scheduler';
import {
  migrateTimedMessagesV1,
  parseSchedulerFile,
  serializeSchedulerFile,
} from '../../src/scheduler-store';
import { scrollbackReplayPadding, spawnPrelude } from '../../src/scrollback-persistence';
import {
  COMMAND_AGENT_ID,
  coerceOpenedBy,
  coerceSessionCommand,
  effectiveDef,
} from '../../src/session-command';
import { presentRoots } from '../../src/session-folders';
import { SessionManager } from '../../src/session-manager';
import { buildStartupModel } from '../../src/session-migration';
import { createSessionOps } from '../../src/session-ops';
import { expandShortNames, hostShortNameDeps } from '../../src/short-names';
import {
  PASTE_MODE_OFF,
  type PasteModeState,
  trackBracketedPaste,
} from '../../src/terminal-output';
import { MIN_DELAY_MS, MIN_INTERVAL_MS, parseTimedMessagesFile } from '../../src/timed-messages';
import type {
  AgentDefinition,
  AgentSource,
  BriefRequest,
  Session,
  SessionCommand,
  SessionOpener,
  SpawnSpec,
  StartRefusal,
} from '../../src/types';
import { HC_XDG_ISOLATED_ENV } from '../hc-cli';
import { type RpcAnswer, RpcFault, type RpcRequest } from '../transport/pipe';
import { createRolloutFs } from './codex-rollout-fs';
import { createCodexRolloutWatch } from './codex-rollout-watch';
import { ServerFolderHealth } from './folder-health';
import { createLimitMonitor } from './limit-monitor';
import { createLimitRulesSource } from './limit-rules-file';
import { ServerSettingsStore } from './server-settings';

export type DomainLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DomainLog = Record<
  DomainLogLevel,
  (scope: string, msg: string, data?: Record<string, unknown>) => void
>;

export interface DomainDeps {
  userData: string;
  homeDir: string;
  platform: NodeJS.Platform;
  /** The `conduit.instance` label (InstanceNames.instance). */
  instance: string;
  e2e: boolean;
  /** The server's own env (process.env): every session's base env (withServerEnv). */
  env: Readonly<Record<string, string | undefined>>;
  runtime: TerminalRuntime;
  launch: LaunchPort;
  drafts: DraftPort;
  scrollback: ScrollbackPort;
  attention: AttentionStatusRead;
  typing: TypingPort;
  emit: ServerEventSink;
  /** ServerLifecycle.stopping (D32): MCP opens refuse with `server_stopping`. */
  stopping(): boolean;
  /** W5's install module (DomainPort.installState). */
  installState: DomainPort['installState'];
  detectShells(): AgentDefinition[];
  detectClis(): AgentDefinition[];
  resolveCommand(command: string): string | undefined;
  /** W6's last known size of the session's terminal, kept after it exits (runtime.lastSizeOf). */
  lastSizeOf(sessionId: string): TermGeometry | undefined;
  /**
   * A closeWhenDone session's program exited on its own. The close routing owner (the MCP host)
   * closes it the way close_session does, so an open window's unsaved-changes guard still runs.
   */
  closeWhenDone(sessionId: string): Promise<void>;
  log: DomainLog;
}

export type DomainSnapshot = Pick<ServerSnapshot, 'sessions' | 'settings' | 'stores' | 'timers'>;

export interface Domain {
  /** The C2 methods and notifications W4 owns; undefined for any other method. */
  handle(request: RpcRequest): Promise<RpcAnswer> | undefined;
  sessions: SessionStorePort;
  domain: DomainPort;
  /**
   * After C1 reconcile (F1.4.5): adopted sessions become live, then D40 decides what reopens.
   * Compose MUST call it after the first reconcile even when that reconcile fails (with `[]`):
   * every cold start waits for the first call, with no timeout.
   */
  adopted(terminals: readonly AdoptedTerminal[]): void;
  /** Every `ui.presence`; W4 reads only the focus part (folder health recheck). */
  presence(windows: readonly WindowPresence[]): void;
  /** Every `term.resize`, besides C1 `resize`: a cold start's replay padding covers the pane's rows. */
  resized(sessionId: string, size: TermGeometry): void;
  /** An app connected: agents.json is re-read (the server outlives app launches) and stores re-emitted if it changed. */
  reloadAgents(): void;
  snapshot(): DomainSnapshot;
  settings(): ServerSettings;
  pendingTimers(): boolean;
  /** A Claude Code hook post the MCP endpoint authenticated (spec §3 "Claude Code adapter"). */
  hookPost(sessionId: string, post: HookPost): void;
  /** A keystroke from the window path (`term.input`), never Conduit's own writer (spec R4). */
  humanInput(sessionId: string): void;
  persist(): Promise<void>;
  dispose(): Promise<void>;
}

/** The C2 requests and notifications W4 answers (main-ts-ownership.md, the server rows). */
type DomainMethod = Extract<
  ServerMethod,
  | `sessions.${string}`
  | `projects.${string}`
  | `launchers.${string}`
  | `briefs.${string}`
  | `timers.${string}`
  | `scheduler.${string}`
  | 'serverSettings.patch'
>;
type Handler<R> = (p: Record<string, unknown>) => R | Promise<R>;
type Handlers = {
  [M in DomainMethod]: Handler<ServerMethods[M]['result']>;
} & {
  'folders.suspect': Handler<Record<string, never>>;
  'system.resumed': Handler<Record<string, never>>;
};

const PERSIST_COALESCE_MS = 150;

/** list_agents' source for each launcher kind (flexible-agent-contracts §4.2). */
const SOURCE_OF_LAUNCHER: Record<LauncherKind, AgentSource> = {
  config: 'profile',
  custom: 'launcher',
  cli: 'detected',
  shell: 'shell',
};

interface Facts {
  generation: number | null;
  spawn: SessionRuntime['spawn'];
  launchId?: string;
  reportedStatus: SessionRuntime['reportedStatus'];
  lastSize: SessionRuntime['lastSize'];
}

/**
 * A start with no `term.resize` yet (a windowless MCP open) runs at hc's default spawn size
 * (docs/runs/2026-11-02-hc-spike/report.md), so that is what ConPTY's spawn clear covers.
 */
const HC_DEFAULT_ROWS = 120;

const dim = (text: string) => `\r\n\x1b[2m— ${text} —\x1b[0m\r\n`;

type StoredSession = Session & Partial<PersistedLaunchCounter>;

const lastGenerationOf = (s: StoredSession): number =>
  typeof s.lastGeneration === 'number' ? s.lastGeneration : 0;

/** The record minus what the app owns and the server-private launch counter. */
function viewFields(s: Session): Omit<Session, AppSessionField> {
  const record: StoredSession = { ...s };
  for (const k of APP_SESSION_FIELDS) delete record[k];
  delete record.lastGeneration;
  return record;
}

const isOwnEnvKey = (upper: string) =>
  upper.startsWith('HC_') || upper.startsWith('CONDUIT_USER_XDG_') || upper === HC_XDG_ISOLATED_ENV;

/**
 * A session's env starts from the server's, as node-pty's did from the app's: a pane gets the
 * core's env with hc's fresh registry values over it (M10), which drops the PATH the app was
 * started with. Our core runs under its isolated XDG, so sessions get the user's own values back,
 * an empty one included, since terminal.run.env can only set (D24, M22).
 */
function withServerEnv(spec: SpawnSpec, env: DomainDeps['env']): SpawnSpec {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(sanitizeChildEnv({ ...env })))
    if (v !== undefined && !isOwnEnvKey(k.toUpperCase())) base[k] = v;
  const restored: Record<string, string> = {};
  if (env[USER_XDG_CAPTURED_ENV] !== undefined)
    for (const [xdg, passthrough] of Object.entries(USER_XDG_PASSTHROUGH)) {
      const value = env[passthrough];
      if (value !== undefined) restored[xdg] = value;
    }
  return { ...spec, env: { ...base, ...spec.env, ...restored } };
}

/** `prelude` with `more` appended as its own run, at the pane's size. */
function composePrelude(prelude: FirstPaint | undefined, more: string): FirstPaint | undefined {
  if (!more) return prelude;
  return {
    data: (prelude?.data ?? '') + more,
    replay: [...(prelude?.replay ?? []), { length: more.length }],
  };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const str = (p: Record<string, unknown>, key: string): string => {
  const v = p[key];
  if (typeof v !== 'string' || v === '') throw new RpcFault('invalid', `Expected ${key}`);
  return v;
};

/** The W4 row of the program: everything the server owns about sessions and its stores. */
export function createDomain(deps: DomainDeps): Domain {
  const { userData, runtime, scrollback, log } = deps;
  const file = (name: string) => join(userData, name);
  const hostPlatform: HostPlatform =
    deps.platform === 'win32' ? 'win32' : deps.platform === 'darwin' ? 'darwin' : 'linux';
  const pathOpts = {
    platform: deps.platform === 'win32' ? ('win32' as const) : ('posix' as const),
    caseSensitive: deps.platform === 'linux',
  };
  const resolveCommand = (c: string) => deps.resolveCommand(c);

  const settingsStore = new ServerSettingsStore(userData, (m) => log.error('persist', m));
  const settings = () => settingsStore.get();

  const registry = new AgentRegistry([]);
  let agentsLast: AgentsConfig | undefined;
  const readAgentsConfig = (): AgentsConfig => {
    const next = loadAgentsConfig(file('agents.json'), {
      homeDir: deps.homeDir,
      e2e: deps.e2e,
      warn: (message, data) => log.warn('agents', message, data),
      error: (message, data) => log.error('agents', message, data),
      last: agentsLast,
    });
    agentsLast = next;
    return next;
  };
  const agentsConfig = readAgentsConfig();
  // The brief host holds this map, so a reload refills it in place.
  const agentBriefs = new Map(agentsConfig.briefs);
  const agentsFingerprint = (c: { defs: unknown; briefs: ReadonlyMap<string, unknown> }) =>
    JSON.stringify([c.defs, [...c.briefs]]);
  let agentsPrint = agentsFingerprint(agentsConfig);
  const launcherHost = new LauncherHost({
    registry,
    config: agentsConfig.defs,
    detectShells: () => deps.detectShells(),
    detectClis: () => deps.detectClis(),
    readFile: () => {
      const read = readFileState(file('launchers.json'));
      if (read.kind === 'unreadable')
        log.warn('persist', 'launchers.json unreadable; not writing it this run', {
          code: read.code,
        });
      return read;
    },
    persist: (t) => writeAsync('launchers.json', t),
    backupCorrupt: () => {
      try {
        copyFileSync(file('launchers.json'), file('launchers.corrupt.json'));
      } catch (e) {
        log.error('persist', `launchers.json backup failed: ${String(e)}`);
      }
    },
    resolveCommand,
    platform: hostPlatform,
    now: Date.now,
  });
  const mgr = new SessionManager(registry);

  const sessionsDisk = parseSessions(readBlob(file('sessions.json')));
  const sessionsWritable = sessionsDisk.kind !== 'newer';
  if (!sessionsWritable)
    log.warn('persist', 'sessions.json has a newer version; writes blocked this run');
  const startup = buildStartupModel({
    sessions: sessionsDisk,
    projects: parseProjects(readFileState(file('projects.json'))),
  });
  for (const warning of startup.warnings) log.warn('persist', warning);
  for (const backup of startup.backups) {
    const to = file(backup.to);
    if (!backup.overwrite && existsSync(to)) continue;
    try {
      atomicWriteFileSync(to, readFileSync(file(backup.from)));
    } catch (err) {
      log.warn('persist', `backup to ${backup.to} failed`, { err: String(err) });
    }
  }
  let projectsWritable = startup.projectsWritable;
  let projectsDirty = startup.writeProjects;
  const projectStore = new ProjectStore(
    startup.projects,
    () => `p-${randomBytes(6).toString('hex')}`,
  );
  if (startup.writeProjects) writeSync('projects.json', serializeProjects(startup.projects));

  const roleBriefs = createRoleBriefHost({
    userData,
    agentBriefs,
    mgr,
    platform: hostPlatform,
    e2e: deps.e2e,
    log,
  });
  // Not gated on restore: a restore-off run keeps briefs of sessions it didn't reopen.
  roleBriefs.sweep(briefKeepIds([], startup.sessions));

  const facts = new Map<string, Facts>();
  const factsOf = (id: string): Facts =>
    facts.get(id) ?? { generation: null, spawn: 'none', reportedStatus: null, lastSize: null };
  const setFacts = (id: string, patch: Partial<Facts>) => {
    // A late runtime event for a closed session must not leave facts behind it. A record held for
    // reconcile (restore off) is not closed: its unconfirmed launch decides whether it reopens.
    if (!mgr.get(id) && !held.some((s) => s.id === id)) return;
    facts.set(id, { ...factsOf(id), ...patch });
    // Only the launch state decides what D40 writes; the rest is runtime-only.
    changed('spawn' in patch || 'generation' in patch);
  };
  const isLive = (id: string) => runtime.get(id)?.state === 'live';
  const restartSeq = new Map<string, number>();
  const requestedSizes = new Map<string, TermGeometry>();
  const startRefusals = new Map<string, StartRefusal>();
  const pendingRelaunchMarker = new Set<string>();
  const starts = new Map<string, Promise<SessionStartResult>>();
  const lastLines = new Map<string, string>();
  /** The last run's exit code, from its transition to exited until the next run starts. */
  const exitCodes = new Map<string, number | null>();
  const pasteModes = new Map<string, PasteModeState>();
  const cwdScanners = new Map<string, CwdScanner>();

  let reconciled = false;
  let markReconciled: () => void = () => {};
  const reconciledReady = new Promise<void>((r) => {
    markReconciled = r;
  });
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingWrites = new Set<Promise<void>>();
  function writeSync(name: string, text: string) {
    try {
      atomicWriteFileSync(file(name), text);
    } catch (e) {
      log.error('persist', `${name} write failed: ${String(e)}`);
    }
  }
  function writeAsync(name: string, text: string) {
    const pending = new Promise<void>((resolve) => {
      atomicWriteFile(file(name), text, (err) => {
        if (err) log.error('persist', `${name} write failed: ${String(err)}`);
        resolve();
      });
    });
    pendingWrites.add(pending);
    void pending.then(() => pendingWrites.delete(pending));
  }
  /** D40: with restore off only what may still run is written, with its launch counter. */
  const persistedSessions = () =>
    settings().restoreSessions
      ? mgr.list()
      : mgr.list().filter((s) => factsOf(s.id).spawn !== 'none' || starts.has(s.id));
  // With restore off the held records are only in memory until reconcile says which run.
  const sessionsWriteAllowed = () =>
    sessionsWritable && (reconciled || settingsAtLoad.restoreSessions);
  const writers: Record<'sessions' | 'timers' | 'projects', () => string | null> = {
    sessions: () => (sessionsWriteAllowed() ? serializeSessions(persistedSessions()) : null),
    // Unloaded (restore off, before reconcile) the in-memory list is empty, not the file's.
    timers: () =>
      timersWritable && timersLoaded
        ? serializeSchedulerFile(
            { version: 2, jobs: timers.list(), episodes: monitor.episodes() },
            Date.now(),
          )
        : null,
    projects: () =>
      projectsWritable && projectsDirty ? serializeProjects(projectStore.list()) : null,
  };
  const fileOf = {
    sessions: 'sessions.json',
    timers: 'scheduler.json',
    projects: 'projects.json',
  };
  const schedulePersist = (what: keyof typeof writers) => {
    if (persistTimers.has(what)) return;
    persistTimers.set(
      what,
      setTimeout(() => {
        persistTimers.delete(what);
        const text = writers[what]();
        if (text !== null) writeAsync(fileOf[what], text);
      }, PERSIST_COALESCE_MS),
    );
  };

  function changed(persist = true) {
    if (persist) schedulePersist('sessions');
    queueMicrotask(() => deps.emit('sessions.changed', { sessions: views() }));
  }
  let timersChangedTimer: ReturnType<typeof setTimeout> | undefined;
  const timersState = () => ({
    schedules: timers.list().flatMap((j) => {
      const m = toTimedMessage(j);
      return m ? [m] : [];
    }),
    offer: monitor.offer(),
    jobs: timers.list(),
    episodes: monitor.episodes(),
  });
  const timersChanged = () => {
    if (timersChangedTimer) return;
    timersChangedTimer = setTimeout(() => {
      timersChangedTimer = undefined;
      deps.emit('timers.changed', timersState());
    }, 0);
  };
  const dataChanged = () => {
    deps.emit('data.changed', { store: 'agents', value: registry.list() });
    deps.emit('data.changed', { store: 'launchers', value: launcherHost.dtos() });
  };
  const reloadAgents = () => {
    const next = readAgentsConfig();
    const print = agentsFingerprint(next);
    const changedConfig = print !== agentsPrint;
    agentsPrint = print;
    agentBriefs.clear();
    for (const [id, source] of next.briefs) agentBriefs.set(id, source);
    launcherHost.setConfig(next.defs);
    const rescanned = launcherHost.rescan();
    if (changedConfig || rescanned) launchersChanged();
  };
  const launchersChanged = () => {
    startRefusals.clear();
    dataChanged();
    changed(false);
  };

  function views(): SessionView[] {
    return mgr.list().map((s) => {
      const rest = viewFields(s);
      const f = factsOf(s.id);
      const agentScope = scopes.view(s.id);
      const seq = restartSeq.get(s.id);
      const startRefusal = startRefusals.get(s.id);
      return {
        ...rest,
        // Neutral until services decorates with ServerAttention's authoritative facts.
        attentionReason: null,
        completions: 0,
        lastLine: lastLines.get(s.id) ?? '',
        ...(exitCodes.has(s.id) ? { exitCode: exitCodes.get(s.id) ?? null } : {}),
        ...(agentScope ? { agentScope } : {}),
        ...(seq === undefined ? {} : { restartSeq: seq }),
        ...(startRefusal ? { startRefusal } : {}),
        runtime: {
          generation: f.generation,
          spawn: f.spawn,
          reportedStatus: f.reportedStatus,
          lastSize: f.lastSize,
        },
      };
    });
  }

  const realKeys = new Map<string, string>();
  const probeDeps: FolderProbeDeps = {
    path,
    kind: async (p) => {
      try {
        return (await fsp.stat(p)).isDirectory() ? 'dir' : 'not-dir';
      } catch {
        return 'missing';
      }
    },
    realpath: (p) => fsp.realpath(p),
    longName: (p) => expandShortNames(p, hostShortNameDeps),
  };
  const scopes = new AgentScopeTracker({
    get: (id) => mgr.get(id),
    exists: (p) =>
      fsp.stat(p).then(
        (st) => st.isDirectory(),
        () => false,
      ),
    onChange: () => changed(false),
  });
  const sessionOps = createSessionOps({
    mgr,
    projects: projectStore,
    probe: (raw) => probeFolder(raw, probeDeps),
    realKeys,
    // Scope recompute and health on the server's own folder mutations (§Internal subscribers).
    onFoldersChanged: (id) => {
      scopes.recompute(id);
      void folders.check(id);
    },
  });
  const folders = new ServerFolderHealth({
    mgr,
    revalidate: (id, folder) => sessionOps.revalidate(id, folder),
    realKeys,
    log,
    healthChanged: (id) => scopes.recompute(id),
  });

  // see spec 2026-11-13-scheduler-auto-resume §3 "Job (persisted)": the first start migrates
  // timed-messages.json v1 and leaves it untouched for a downgrade.
  const schedulerBlob = readBlob(file('scheduler.json')) ?? null;
  const schedulerParse = (() => {
    const maxAttempts = settings().autoResumeMaxAttempts;
    if (schedulerBlob === null) {
      const v1 = parseTimedMessagesFile(readBlob(file('timed-messages.json')));
      const migrated = migrateTimedMessagesV1(v1, { maxAttempts });
      if (migrated.jobs.length > 0)
        log.info('scheduler', 'migrated timed-messages.json', { jobs: migrated.jobs.length });
      return { version: 2 as const, ...migrated };
    }
    const parsed = parseSchedulerFile(schedulerBlob, { maxAttempts });
    if (parsed.kind === 'newer')
      log.warn('scheduler', 'scheduler.json is from a newer build; not written');
    else if (
      parsed.jobs.length === 0 &&
      parsed.episodes.length === 0 &&
      schedulerBlob.trim() !== ''
    )
      log.warn('scheduler', 'scheduler.json unreadable or empty; starting with no jobs');
    return parsed;
  })();
  const timersWritable = schedulerParse.kind !== 'newer';

  const cliOf = (id: string): CliKind | null => {
    const s = mgr.get(id);
    const def = s ? effectiveDef(s, registry) : undefined;
    const a = def ? adapterFor(def, { e2e: deps.e2e }) : undefined;
    return a && (CLI_KINDS as readonly string[]).includes(a.id) ? (a.id as CliKind) : null;
  };
  const schedulerLog = {
    info: (msg: string, data?: object) => log.info('scheduler', msg, data && { ...data }),
    debug: (msg: string, data?: object) => log.debug('scheduler', msg, data && { ...data }),
    warn: (msg: string, data?: object) => log.warn('scheduler', msg, data && { ...data }),
  };
  const rules = createLimitRulesSource({
    userData: deps.userData,
    watchDirWhilePresent,
    fs: {
      read: (p) => readBlob(p) ?? null,
      writeAtomic: (p, data) => atomicWriteFileSync(p, data),
    },
    onChange: () => log.info('scheduler', 'limit rules reloaded'),
    log: schedulerLog,
  });

  // The Scheduler asks the monitor before every resume; the monitor arms through the Scheduler.
  let monitor: ReturnType<typeof createLimitMonitor>;
  const timers = new Scheduler({
    now: () => Date.now(),
    setTimer: (ms, fn) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    isAlive: isLive,
    sessionExists: (id) => !!mgr.get(id),
    preFire: (job) => monitor.preFire(job),
    // The bare writer: timed messages submit with no gate (F8). see spec R5 for `bracketed`.
    deliver: async (job) => {
      const check = normalizeMessage(job.action.message);
      if (!check.ok) return { ok: false, reason: check.error };
      const bracketed = !!pasteModes.get(job.sessionId)?.on;
      const { text, joined } = deliverableText(check.message, bracketed);
      const outcome = await deps.typing.submit(job.sessionId, text, { bracketed, settle: 'quiet' });
      return outcome === 'submitted' ? { ok: true, joined } : { ok: false, reason: outcome };
    },
    onChange: () => {
      schedulePersist('timers');
      timersChanged();
    },
    onFired: (ev) => {
      log.info('scheduler', 'fired', { ...ev });
      deps.emit('timers.fired', ev);
    },
    onJobFailed: (job, reason) => {
      log.warn('scheduler', 'job failed', { jobId: job.id, sessionId: job.sessionId, reason });
      monitor.onJobFailed(job, reason);
    },
    verifyMs: () => settings().autoResumeVerifyMs,
    minDelayMs: deps.e2e ? 0 : MIN_DELAY_MS,
    minIntervalMs: deps.e2e ? 0 : MIN_INTERVAL_MS,
  });
  monitor = createLimitMonitor({
    now: () => Date.now(),
    setTimer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    scheduler: timers,
    settings: () => settings(),
    sessionMode: (id) => mgr.get(id)?.autoResume,
    cliOf,
    isBusy: (id) => deps.attention.statusOf(id).busy,
    screen: async (id) => (await runtime.screen(id))?.lines ?? null,
    scanRules: (cli, rows, now) => matchLimitRules(rules.current(), cli, rows, now),
    setResumeIssue: (id, reason) => deps.attention.setResumeIssue(id, reason),
    onChange: () => {
      schedulePersist('timers');
      timersChanged();
    },
    log: schedulerLog,
  });
  const codexHome = deps.env.CODEX_HOME || join(deps.homeDir, '.codex');
  const metaCapWarned = new Set<string>();
  const codexWatch = createCodexRolloutWatch({
    sessionsRoot: join(codexHome, 'sessions'),
    now: () => Date.now(),
    localDate: (ms) => {
      const d = new Date(ms);
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    },
    watchDir,
    fs: createRolloutFs({
      onFirstLineTooLong: (file) => {
        if (metaCapWarned.has(file)) return;
        metaCapWarned.add(file);
        log.warn('scheduler', 'rollout first line over the read cap; not bound', { file });
      },
    }),
    samePath: (a, b) => folderKey(a) === folderKey(b),
    episodeOpen: (id) => monitor.episodes().some((e) => e.sessionId === id && e.state === 'open'),
    onSignal: (signal) => monitor.signal(signal),
    onBound: (id) => monitor.onAdapterLive(id),
    log: schedulerLog,
  });
  const settingsAtLoad = settings();
  // With restore off, records wait for reconcile: only a live or unconfirmed one reopens (D40).
  let held: Session[] = [];
  let timersLoaded = false;
  const loadTimers = () => {
    // After the session set: a job whose session is gone is dropped at load. Episodes first, so
    // the pre-fire check of an overdue resume sees them (spec R1).
    monitor.load(schedulerParse.episodes.filter((e) => !!mgr.get(e.sessionId)));
    timers.load(schedulerParse.jobs);
    timersLoaded = true;
  };
  if (settingsAtLoad.restoreSessions) {
    mgr.restore(startup.sessions);
    loadTimers();
    for (const s of mgr.list()) void folders.check(s.id);
  } else held = startup.sessions;
  if (startup.writeSessions && sessionsWriteAllowed())
    writeSync('sessions.json', serializeSessions(persistedSessions()));

  mgr.onChange(() => changed());
  projectStore.onChange(() => {
    projectsDirty = true;
    schedulePersist('projects');
    deps.emit('data.changed', { store: 'projects', value: projectStore.list() });
  });

  // Called on every reconcile (start and each core reconnect); only the first decides what reopens.
  function adopted(terminals: readonly AdoptedTerminal[]) {
    if (!reconciled && !settingsAtLoad.restoreSessions) {
      const adoptedIds = new Set(terminals.map((t) => t.sessionId));
      const reopen = held.filter(
        (s) => adoptedIds.has(s.id) || factsOf(s.id).spawn !== 'none' || exitCodes.has(s.id),
      );
      held = [];
      mgr.restore(reopen);
      for (const s of reopen) if (exitCodes.has(s.id)) mgr.setStatus(s.id, 'exited');
      loadTimers();
      for (const s of reopen) void folders.check(s.id);
    }
    for (const t of terminals) {
      if (!mgr.get(t.sessionId)) continue;
      if (t.state === 'live') {
        setFacts(t.sessionId, {
          generation: t.generation,
          spawn: 'live',
          launchId: t.launchId,
          lastSize: t.size,
        });
        mgr.setStatus(t.sessionId, 'running');
        // A job loaded before reconcile saw no live PTY and is waiting: an adopted terminal is
        // its PTY coming back (spec §4 "Server restarted between arm and fire").
        timers.onPtyStart(t.sessionId);
      } else mgr.setStatus(t.sessionId, 'exited');
    }
    reconciled = true;
    markReconciled();
    changed();
  }

  const cwdGate = createCwdReportGate({
    stat: (p) =>
      fsp.stat(p).then(
        (st) => (st.isDirectory() ? 'dir' : 'file'),
        () => null,
      ),
    userRoots: (id) => {
      const s = mgr.get(id);
      return s ? userRootsOf(s, pathOpts) : null;
    },
    // Only `cwd`; the sub-repo follow is the app's, from this field (D39).
    accept: (id, cwd) => mgr.setCwd(id, cwd),
    ...pathOpts,
  });

  const endEpisode = (id: string) => {
    cwdScanners.delete(id);
    cwdGate.drop(id);
    pasteModes.delete(id);
  };

  const onData = (id: string, chunk: string) => {
    if (!mgr.get(id)) return;
    const tail = runtime.tailLines(id, 1);
    const line = lastNonEmptyLine(tail.at(-1) ?? '');
    if (lastLines.get(id) !== line) {
      lastLines.set(id, line);
      changed(false);
    }
    // see spec R2: every session, so a scheduled paste knows whether to bracket.
    pasteModes.set(id, trackBracketedPaste(pasteModes.get(id) ?? PASTE_MODE_OFF, chunk));
    if (scopes.tracks(id)) scopes.output(id, chunk);
    monitor.onData(id);
    if (settings().trackCwd) {
      let scanner = cwdScanners.get(id);
      if (!scanner) {
        scanner = new CwdScanner();
        cwdScanners.set(id, scanner);
      }
      const cwd = scanner.push(chunk);
      // Every report goes through the gate: it must supersede an older one still being stat'ed.
      if (cwd !== null) cwdGate.report(id, cwd);
    }
  };

  const current = (id: string, generation: number) => factsOf(id).generation === generation;
  const onRuntime = (e: RuntimeEvent) => {
    switch (e.type) {
      case 'data':
        if (current(e.sessionId, e.generation)) onData(e.sessionId, e.data);
        return;
      // hc's synthetic screen carries the program's modes: a CLI that switched bracketed paste
      // on at startup, or before a server restart, says so only here (spec R2).
      case 'paint':
        if (current(e.sessionId, e.generation))
          pasteModes.set(
            e.sessionId,
            // A paint is a full synthetic screen (terminal-runtime.ts): its modes are the truth.
            trackBracketedPaste(PASTE_MODE_OFF, e.data),
          );
        return;
      case 'spawned':
        setFacts(e.sessionId, { generation: e.generation, spawn: 'live', lastSize: e.size });
        if (mgr.get(e.sessionId)?.status !== 'running') mgr.setStatus(e.sessionId, 'running');
        return;
      case 'unconfirmed':
        setFacts(e.sessionId, {
          generation: e.generation,
          spawn: 'unconfirmed',
          launchId: e.launchId,
        });
        return;
      case 'exit':
        if (!current(e.sessionId, e.generation)) {
          const persisted = mgr.get(e.sessionId) ?? held.find((s) => s.id === e.sessionId);
          if (
            factsOf(e.sessionId).generation !== null ||
            !persisted ||
            lastGenerationOf(persisted) !== e.generation
          )
            return;
          setFacts(e.sessionId, { generation: e.generation });
        }
        log.info('pty', 'exit', { sessionId: e.sessionId, code: e.code, reason: e.reason });
        exitCodes.set(e.sessionId, e.code);
        setFacts(e.sessionId, { spawn: 'none' });
        // A restored session stays stale (F1.4.5) unless its agent quit on its own: a leftover kill
        // from Conduit's own stop, or a vanished PTY, must not read as "the agent exited" (CON-138).
        if (mgr.get(e.sessionId)?.status === 'running' || e.reason === 'exited') {
          mgr.setStatus(e.sessionId, 'exited');
        }
        endEpisode(e.sessionId);
        scopes.ended(e.sessionId);
        monitor.onPtyExit(e.sessionId, e.reason);
        if (e.reason === 'exited') codexWatch.untrack(e.sessionId);
        // Only a program that quit on its own: a kill from Conduit's own stop must not delete it.
        if (e.reason === 'exited' && mgr.get(e.sessionId)?.closeWhenDone) {
          deps.closeWhenDone(e.sessionId).catch((err: unknown) =>
            log.warn('session', 'closeWhenDone close failed', {
              sessionId: e.sessionId,
              err: String(err),
            }),
          );
        }
        return;
      case 'status':
        setFacts(e.sessionId, { reportedStatus: e.status });
        return;
      case 'size':
        setFacts(e.sessionId, { lastSize: e.size });
        return;
      case 'title':
        mgr.applyTitle(e.sessionId, e.title);
        return;
      default:
        return;
    }
  };
  const unsubscribe = runtime.on(onRuntime);
  // see spec R3 / R13: the monitor decides whether a busy edge counts as a resumed turn.
  const unwatchBusy = deps.attention.onChange(() => {
    for (const session of mgr.list())
      monitor.onBusy(session.id, deps.attention.statusOf(session.id).busy);
  });

  /** The single producer; persisted before the run, so a restart never reuses a generation. */
  function allocateLaunch(id: string): LaunchIds {
    const s = mgr.get(id);
    if (!s) throw new RpcFault('not_found', 'Session no longer exists');
    if (!sessionsWriteAllowed()) throw new RpcFault('unavailable', 'sessions-unavailable');
    const persisted = s as StoredSession;
    const previous = persisted.lastGeneration;
    const counter: PersistedLaunchCounter = { lastGeneration: lastGenerationOf(s) + 1 };
    Object.assign(s, counter);
    try {
      atomicWriteFileSync(file('sessions.json'), serializeSessions(persistedSessions()));
    } catch (e) {
      if (previous === undefined) delete persisted.lastGeneration;
      else persisted.lastGeneration = previous;
      log.error('persist', `sessions.json write failed: ${String(e)}`);
      throw new RpcFault('unavailable', 'sessions-unavailable');
    }
    return { generation: counter.lastGeneration, launchId: randomBytes(16).toString('hex') };
  }

  /**
   * The ring before the live launch, then a screen of newlines: hc's history paint opens by
   * erasing the screen in place, which would wipe the replay's last screen otherwise.
   */
  const earlierRuns = (id: string): FirstPaint | undefined => {
    const before = settings().scrollbackPersistence ? scrollback.replayBeforeLaunch(id) : null;
    if (!before) return undefined;
    const rows = (requestedSizes.get(id) ?? deps.lastSizeOf(id))?.rows ?? HC_DEFAULT_ROWS;
    return composePrelude(before, scrollbackReplayPadding(deps.platform, rows));
  };

  const attachResult = (id: string): SessionStartResult | undefined => {
    const t = runtime.get(id);
    if (t?.state !== 'live') return undefined;
    const prelude = earlierRuns(id);
    return {
      ok: true,
      target: t.target,
      generation: t.generation,
      spawned: false,
      ...(prelude ? { prelude } : {}),
    };
  };

  /** What answers a start without spawning; run again after the first reconcile, which may change it. */
  const preflight = (id: string, retry: boolean): SessionStartResult | undefined => {
    // A live session still attaches while stopping: a restart's settle leaves it running.
    const live = attachResult(id);
    if (live) return live;
    if (deps.stopping()) return { ok: false, refusal: { reason: 'server_stopping' } };
    const f = factsOf(id);
    if (f.spawn === 'unconfirmed' && f.launchId && !retry)
      return { ok: false, refusal: { reason: 'spawn_unconfirmed', launchId: f.launchId } };
    return undefined;
  };

  function start(id: string, retry: boolean): Promise<SessionStartResult> {
    const inFlight = starts.get(id);
    if (inFlight) return inFlight.then((r) => attachResult(id) ?? r);
    if (!mgr.get(id)) return Promise.reject(new RpcFault('not_found', 'Session no longer exists'));
    const early = preflight(id, retry);
    if (early) return Promise.resolve(early);
    const run = coldStart(id, retry).finally(() => starts.delete(id));
    starts.set(id, run);
    return run;
  }

  /** `mode: 'view'`: a live session attaches; any other is shown its stored output, never spawned. */
  async function view(id: string): Promise<SessionStartResult> {
    // Before the first reconcile, or under a start in flight, a live terminal isn't known yet.
    await reconciledReady;
    await starts.get(id)?.catch(() => undefined);
    if (!mgr.get(id)) throw new RpcFault('not_found', 'Session no longer exists');
    const live = attachResult(id);
    if (live) return live;
    const history = settings().scrollbackPersistence ? scrollback.replayForView(id) : null;
    return {
      ok: true,
      viewed: { exitCode: exitCodes.get(id) ?? null },
      prelude: history ?? { data: '', replay: [] },
    };
  }

  const refuseStart = (id: string, text: string) => {
    scrollback.show(id, dim(text));
    pendingRelaunchMarker.delete(id);
    // Nothing runs, so never 'exited': the app auto-closes an exited shell.
    mgr.setStatus(id, 'stale');
  };

  async function coldStart(id: string, retry: boolean): Promise<SessionStartResult> {
    // Until the first reconcile a running terminal or an unconfirmed launch of this session is not
    // known yet, and spawning would start a second run of it.
    await reconciledReady;
    if (!mgr.get(id)) throw new RpcFault('not_found', 'Session no longer exists');
    const early = preflight(id, retry);
    if (early) return early;
    // A restored session's first health check may still be marking missing folders.
    await folders.pending(id);
    // A session restored at start launches before the MCP endpoint listens; it waits, bounded.
    await deps.launch.whenLaunchReady();
    const s = mgr.get(id);
    if (!s) throw new RpcFault('not_found', 'Session no longer exists');
    // Neutralized history of the previous process, before the plan check as today, so a refused
    // start still shows it. Once per start: each call records the replay's tail in the ring.
    const replay = settings().scrollbackPersistence ? scrollback.replayForColdStart(id) : null;
    const history = replay?.data ? replay : undefined;
    const refused = (
      refusal: Extract<SessionStartResult, { ok: false }>['refusal'],
      prelude: FirstPaint | undefined = history,
    ): SessionStartResult => ({ ok: false, refusal, ...(prelude ? { prelude } : {}) });
    if (s.agentId === COMMAND_AGENT_ID && !s.command) {
      refuseStart(id, "can't start: the saved command is invalid");
      log.warn('pty', 'refused', { sessionId: id, reason: 'command-invalid' });
      return refused({ reason: 'command-invalid' });
    }
    const def = effectiveDef(s, registry);
    const plan = buildLaunchSpec({
      def,
      cwd: s.cwd,
      home: s.home,
      homeMissing: !!s.homeMissing,
      roots: presentRoots(s),
      exists: existsSync,
      resolveCommand,
      platform: hostPlatform,
    });
    if (!plan.ok) {
      const why =
        plan.reason === 'unresolvable'
          ? `${plan.command} not found`
          : `home folder ${s.home} is missing`;
      refuseStart(id, `can't start: ${why}`);
      log.warn('pty', 'refused', { sessionId: id, reason: plan.reason, home: s.home });
      if (plan.reason === 'home-missing') {
        // Re-checks the folders, so a home that has come back clears and the next start works.
        void folders.check(id);
        return refused({ reason: 'home-missing' });
      }
      const refusal: StartRefusal = { reason: 'unresolvable', command: plan.command };
      startRefusals.set(id, refusal);
      changed(false);
      return refused(refusal);
    }
    for (const root of plan.skippedAddDirRoots)
      log.warn('pty', 'add-dir skipped', { sessionId: id, root });
    let spec = withServerEnv(plan.spec, deps.env);
    if (settings().trackCwd) {
      const aug = cwdReportingAugmentation(def?.id ?? s.agentId, spec.args);
      if (aug?.args) spec = { ...spec, args: [...spec.args, ...aug.args] };
      if (aug?.env) spec = { ...spec, env: { ...spec.env, ...aug.env } };
    }
    const ids = allocateLaunch(id);
    if (def) spec = await deps.launch.prepareLaunch(id, def, spec, ids);
    if (!mgr.get(id)) throw new RpcFault('not_found', 'Session no longer exists');
    // brief --add-dir is not a session root (role-brief spec §3.2)
    const scopeArgs = spec.args;
    const brief = roleBriefs.prepareSpawn(id, def, spec);
    spec = brief.spec;
    for (const banner of brief.banners) scrollback.show(id, banner);
    log.info('pty', 'spawn', {
      sessionId: id,
      agentId: s.agentId,
      command: spec.command,
      cwd: spec.cwd,
    });
    const labels: ConduitLabels = {
      'conduit.session': id,
      'conduit.instance': deps.instance,
      'conduit.generation': String(ids.generation),
      'conduit.launch': ids.launchId,
      'conduit.role': 'session',
    };
    // From here the data subscribers read this generation's output, from a clean episode: its
    // first bytes may arrive before the spawn resolves.
    setFacts(id, { generation: ids.generation, launchId: ids.launchId });
    endEpisode(id);
    lastLines.delete(id);
    exitCodes.delete(id);
    // Claude's visible scope is read off the final args, so a user's own --add-dir counts.
    if (plan.addDir) scopes.captured(id, scopeFromSpawnArgs(spec.cwd, scopeArgs, resolve, s));
    // Composed before the spawn: the child's first output may reach the ring before the reply.
    const recordedRows = history?.replay.findLast((r) => r.geometry)?.geometry?.rows;
    const rows = (requestedSizes.get(id) ?? deps.lastSizeOf(id))?.rows ?? HC_DEFAULT_ROWS;
    const marker = spawnPrelude(deps.platform, rows, {
      relaunched: pendingRelaunchMarker.delete(id),
      replayed: !!history,
      ...(recordedRows === undefined ? {} : { recordedRows }),
    });
    const prelude = composePrelude(history, marker);
    // In the ring before the child's first output; the app writes it from the prelude, so no show.
    // A refused spawn leaves it there too, and every refusal below returns it in the prelude, so
    // ring and pane agree (lead decision, w4 round 3 SF2).
    if (marker) scrollback.record(id, marker);
    const launchAt = Date.now();
    const result = await runtime.spawn(id, spec, labels, ids);
    brief.commit(result.ok && 'terminal' in result);
    if (!(result.ok && 'terminal' in result)) scopes.ended(id);
    if (!result.ok) {
      const { refusal } = result;
      if (!mgr.get(id)) {
        // Closed mid-spawn: the close found nothing to discard yet.
        if (refusal.reason === 'spawn_unconfirmed')
          await runtime.discardLaunch(id, refusal.launchId);
        facts.delete(id);
        throw new RpcFault('not_found', 'Session no longer exists');
      }
      if (refusal.reason === 'spawn_failed') {
        // hc refused the run: a can't-start like a missing command. C2 has no spawn_failed refusal,
        // so the result maps to `unresolvable`; the view's startRefusal stays unset, since its
        // panel reads "not found" and hc's message says what really failed.
        setFacts(id, { spawn: 'none' });
        endEpisode(id);
        refuseStart(id, `can't start: ${refusal.message}`);
        log.warn('pty', 'refused', {
          sessionId: id,
          reason: 'spawn_failed',
          message: refusal.message,
        });
        // The marker is already in the ring, so the pane is shown it too.
        return refused({ reason: 'unresolvable', command: spec.command }, prelude);
      }
      if (refusal.reason === 'spawn_unconfirmed')
        setFacts(id, { spawn: 'unconfirmed', launchId: refusal.launchId });
      scrollback.show(
        id,
        dim(
          refusal.reason === 'spawn_unconfirmed'
            ? 'launch unconfirmed: retry or discard it'
            : 'Conduit is stopping',
        ),
      );
      return refused(refusal, prelude);
    }
    if ('finished' in result) {
      exitCodes.set(id, result.finished.exitCode);
      setFacts(id, { spawn: 'none' });
      mgr.setStatus(id, 'exited');
      endEpisode(id);
      // W6 already put the output in the ring; a second replay would record the tail twice.
      const final = composePrelude(prelude, result.finished.output) ?? { data: '', replay: [] };
      return { ok: true, finished: result.finished, prelude: final };
    }
    const { terminal } = result;
    if (!mgr.get(id)) {
      await runtime.kill(id);
      throw new RpcFault('not_found', 'Session no longer exists');
    }
    setFacts(id, { generation: terminal.generation, spawn: 'live', lastSize: terminal.size });
    startRefusals.delete(id);
    mgr.setStatus(id, 'running');
    mgr.touch(id);
    // A message written into a shell that has not printed its prompt is lost: settle first.
    timers.onPtyStart(id);
    const cli = cliOf(id);
    if (cli === 'codex') {
      codexWatch.untrack(id);
      codexWatch.track(id, { cwd: spec.cwd, launchAt });
    }
    // The host injected Claude's hooks for this launch (its own settings file, not a user's
    // --settings): they speak for the session (spec R13).
    monitor.onLaunch(id);
    const settingsAt = spec.args.indexOf('--settings');
    if (
      cli === 'claude' &&
      settingsAt >= 0 &&
      spec.args[settingsAt + 1] === claudeSettingsFileOf(join(userData, 'conduit-mcp'), id)
    )
      monitor.onAdapterLive(id);
    return {
      ok: true,
      target: terminal.target,
      generation: terminal.generation,
      spawned: true,
      ...(prelude ? { prelude } : {}),
    };
  }

  async function prepareOpen(rawHome: string, roots: unknown, projectId: unknown) {
    const home = await probeDeps.longName(rawHome);
    try {
      realKeys.set(folderKey(home), folderKey(await probeDeps.realpath(home)));
    } catch {
      // Gone again after the stat: its key stays lexical-only, like a folder first seen missing.
    }
    const initial = await sessionOps.resolveInitialRoots(home, roots);
    return {
      home,
      initial,
      projectId:
        typeof projectId === 'string' && projectStore.has(projectId) ? projectId : undefined,
    };
  }

  interface CreateInput {
    agentId: string;
    home: string;
    name?: string;
    roots?: unknown;
    projectId?: unknown;
    brief: BriefRequest | undefined;
    command?: SessionCommand;
    openedBy?: SessionOpener;
    closeWhenDone?: boolean;
    model?: string;
    cardId?: string;
    opener: { sessionId?: string; focus: boolean };
  }

  async function create(
    i: CreateInput,
  ): Promise<{ sessionId: string; droppedRoots: DroppedRoot[] } | { error: string }> {
    const def = effectiveDef({ agentId: i.agentId, command: i.command }, registry);
    if (!def) return { error: 'unknown_agent' };
    const { home, initial, projectId } = await prepareOpen(i.home, i.roots, i.projectId);
    const c = roleBriefs.beginCreate({ def, request: i.brief, dialog: true });
    if (!c.ok) return { error: c.error };
    let id: string;
    try {
      id = mgr.create(def.id, home, {
        ...(i.cardId ? { cardId: i.cardId } : {}),
        roots: initial.roots,
        missingRoots: initial.missing,
        ...(projectId ? { projectId } : {}),
        ...(i.name !== undefined ? { name: i.name } : {}),
        ...(i.command ? { command: i.command } : {}),
        ...(i.openedBy ? { openedBy: i.openedBy } : {}),
        ...(i.closeWhenDone ? { closeWhenDone: true } : {}),
        ...(i.model !== undefined ? { model: i.model } : {}),
        id: c.id,
        ...(c.brief ? { brief: c.brief } : {}),
      }).id;
    } catch (err) {
      c.rollback();
      throw err;
    }
    // A person's open counts as launcher usage; an MCP open never does. The app ranks the pills
    // from the last launchers push, so a bump is one.
    if (!i.openedBy) {
      launcherHost.bump(def.id);
      deps.emit('data.changed', { store: 'launchers', value: launcherHost.dtos() });
    }
    // Synchronous with the create: the coalesced sessions.changed that lists it comes later.
    deps.emit('sessions.opened', {
      sessionId: id,
      ...(i.opener.sessionId ? { openerSessionId: i.opener.sessionId } : {}),
      focus: i.opener.focus,
    });
    void folders.check(id);
    return { sessionId: id, droppedRoots: initial.dropped };
  }

  async function createFromApp(
    p: Record<string, unknown>,
  ): Promise<ServerMethods['sessions.create']['result']> {
    if (deps.stopping()) throw new RpcFault('server_stopping', 'Conduit is stopping');
    const agentId = str(p, 'agentId');
    const home = str(p, 'home');
    if (!registry.get(agentId) && agentId !== COMMAND_AGENT_ID)
      throw new RpcFault('invalid', 'unknown-agent');
    // Only existence is checked: a filesystem-root home stays openable.
    const kind = await probeDeps.kind(home);
    if (kind !== 'dir')
      throw new RpcFault('invalid', kind === 'missing' ? 'home-missing' : 'invalid-path');
    // A present but malformed brief is refused, not read as absent ("the agent's brief").
    const brief = parseBriefRequest(p.brief);
    if (p.brief !== undefined && brief === undefined)
      throw new RpcFault('invalid', 'brief-invalid');
    const placement = p.placement as { nearSessionId?: unknown; focus?: unknown } | undefined;
    const r = await create({
      agentId,
      home,
      ...(typeof p.name === 'string' ? { name: p.name } : {}),
      roots: p.roots,
      projectId: p.projectId,
      brief,
      ...optional('command', coerceSessionCommand(p.command)),
      ...optional('openedBy', coerceOpenedBy(p.openedBy)),
      ...(typeof p.cardId === 'string' ? { cardId: p.cardId } : {}),
      opener: {
        ...(typeof placement?.nearSessionId === 'string'
          ? { sessionId: placement.nearSessionId }
          : {}),
        focus: placement?.focus !== false,
      },
    });
    if ('error' in r)
      throw new RpcFault(r.error === 'unknown_agent' ? 'invalid' : 'refused', r.error);
    return r;
  }

  async function openSession(req: McpOpenRequest): Promise<DomainOpenOutcome> {
    if (deps.stopping())
      return { ok: false, code: 'server_stopping', message: 'Conduit is stopping' };
    const caller = mgr.get(req.callerSessionId);
    const command = req.launch.kind === 'command' ? req.launch.command : undefined;
    const agentId = req.launch.kind === 'agent' ? req.launch.agentId : COMMAND_AGENT_ID;
    const r = await create({
      agentId,
      home: req.home,
      ...(req.label !== undefined ? { name: req.label } : {}),
      projectId: caller?.projectId,
      // A command has no brief to deliver; an agent gets its definition's default.
      brief: command ? { kind: 'none' } : undefined,
      ...(command ? { command } : {}),
      openedBy: req.openedBy,
      closeWhenDone: req.closeWhenDone,
      ...(req.model !== undefined ? { model: req.model } : {}),
      opener: { sessionId: req.callerSessionId, focus: req.focus },
    });
    if ('error' in r) {
      return r.error === 'unknown_agent'
        ? { ok: false, code: 'unknown_agent', message: `unknown agent: ${agentId}` }
        : { ok: false, code: 'brief_unavailable', message: r.error };
    }
    // Windowless spawn (F3): hc's default size until an app asks for one.
    const started = await start(r.sessionId, false).catch((e: unknown) => {
      log.warn('session', 'MCP open start failed', { sessionId: r.sessionId, err: String(e) });
      return undefined;
    });
    if (started && !started.ok) {
      if (started.refusal.reason === 'spawn_unconfirmed')
        return {
          ok: false,
          code: 'spawn_unconfirmed',
          message: 'The launch could not be confirmed; close this session before opening another',
          sessionId: r.sessionId,
        };
      if (started.refusal.reason === 'server_stopping')
        return { ok: false, code: 'server_stopping', message: 'Conduit is stopping' };
    }
    // The session exists either way: a start that threw or refused for its own reasons (a command
    // not found, a home gone) shows in the pane like an app open, and the caller can close it.
    return { ok: true, sessionId: r.sessionId, label: mgr.get(r.sessionId)?.name ?? '' };
  }

  async function closeSession(
    id: string,
  ): Promise<{ ok: true } | { ok: false; code: 'unknown_session'; message: string }> {
    if (!mgr.get(id))
      return { ok: false, code: 'unknown_session', message: 'session no longer exists' };
    const f = factsOf(id);
    // A discarded launch that registers later matches no row and is killed on its created event.
    if (f.spawn === 'unconfirmed' && f.launchId) await runtime.discardLaunch(id, f.launchId);
    else if (isLive(id)) await runtime.kill(id);
    // Before the record goes: its unread messages are marked undelivered under its handle.
    await deps.launch.onSessionDeleted(id);
    void roleBriefs.onSessionDeleted(id);
    mgr.remove(id);
    scopes.ended(id);
    endEpisode(id);
    for (const m of [facts, restartSeq, startRefusals, lastLines, requestedSizes, exitCodes])
      m.delete(id);
    pendingRelaunchMarker.delete(id);
    timers.onSessionDisposed(id);
    monitor.onSessionClosed(id);
    codexWatch.untrack(id);
    scrollback.forget(id);
    changed();
    return { ok: true };
  }

  async function restart(id: string): Promise<ServerMethods['sessions.restart']['result']> {
    await folders.pending(id);
    const s = mgr.get(id);
    if (!s || s.homeMissing) {
      const reason = s ? 'homeMissing' : 'noSession';
      log.info('agentScope', `restart refused: ${reason}`, { sessionId: id });
      return { sessionId: id, ok: false, reason };
    }
    // No exit for this generation: the session stays, and the remounted pane's start spawns.
    if (isLive(id)) {
      await runtime.retire(id);
      setFacts(id, { spawn: 'none' });
      endEpisode(id);
      monitor.onSessionClosed(id);
      scopes.ended(id);
      restartSeq.set(id, (restartSeq.get(id) ?? 0) + 1);
    }
    log.info('session', 'restart', { sessionId: id });
    mgr.setStatus(id, 'running');
    pendingRelaunchMarker.add(id);
    changed();
    return { sessionId: id, ok: true };
  }

  async function relaunch(ids: unknown): Promise<{ relaunched: string[] }> {
    const relaunched: string[] = [];
    if (!isStringArray(ids)) throw new RpcFault('invalid', 'Expected sessionIds');
    for (const id of ids) {
      await folders.pending(id);
      const s = mgr.get(id);
      // A homeMissing session never spawns; the renderer is not trusted.
      if (!s || s.homeMissing) {
        log.info('session', 'relaunch refused', {
          sessionId: id,
          reason: s ? 'homeMissing' : 'noSession',
        });
        continue;
      }
      mgr.setStatus(id, 'running');
      pendingRelaunchMarker.add(id);
      relaunched.push(id);
    }
    return { relaunched };
  }

  function addDirs(id: string): ServerMethods['sessions.addDirs']['result'] {
    const generation = runtime.get(id)?.generation;
    const r = runAddDir({
      sessionExists: () => !!mgr.get(id),
      isAlive: () => isLive(id),
      isBusy: () => !!deps.attention.statusOf(id).busy,
      typeable: () => scopes.typeable(id),
      bracketedPaste: () => !!pasteModes.get(id)?.on,
      write: (d) => {
        // A paste the human still has to submit is a draft to the notice gate (F8).
        deps.drafts.noteHostInput(id, d);
        return deps.typing.write(id, d, generation === undefined ? {} : { generation });
      },
      onPasted: (p) => scopes.pasted(id, p),
    });
    log.info('agentScope', r.ok ? 'add-dir pasted' : r.reason, { sessionId: id });
    return r.ok ? { sessionId: id, ok: true } : { sessionId: id, ok: false, reason: r.reason };
  }

  async function mutate(
    id: string,
    m: SessionMutation,
  ): Promise<ServerMethods['sessions.mutate']['result']> {
    const op = (
      r:
        | { ok: true }
        | { ok: false; reason: NonNullable<ServerMethods['sessions.mutate']['result']['reason']> },
    ) => (r.ok ? { ok: true } : { ok: false, reason: r.reason });
    if (!mgr.get(id)) return { ok: false, reason: 'unknown-session' };
    switch (m?.op) {
      case 'rename':
        mgr.rename(id, String(m.name ?? ''));
        return { ok: true };
      case 'setIconOverride':
        mgr.setIconOverride(id, typeof m.icon === 'string' ? m.icon : null);
        return { ok: true };
      case 'setHome':
        return op(await sessionOps.setHome(id, m.path, m.keepOldHome !== false));
      case 'addRoot':
        return op(await sessionOps.addRoot(id, m.path));
      case 'removeRoot':
        return op(sessionOps.removeRoot(id, m.path));
      case 'replaceRoot':
        if (typeof m.from !== 'string' || typeof m.to !== 'string')
          throw new RpcFault('invalid', 'Expected from/to');
        return op(await sessionOps.replaceRoot(id, m.from, m.to));
      case 'setProject':
        return op(sessionOps.setProject(id, m.projectId ?? undefined));
      default:
        throw new RpcFault('invalid', 'Unknown mutation');
    }
  }

  /** A blocked projects.json is re-read before each mutation; a clean read unblocks it. */
  const projectsAvailable = (): boolean => {
    if (projectsWritable) return true;
    const load = parseProjects(readFileState(file('projects.json')));
    if (load.kind !== 'ok' && load.kind !== 'absent') return false;
    projectsWritable = true;
    projectStore.replaceAll(load.kind === 'ok' ? load.projects : []);
    return true;
  };

  const methods: Handlers = {
    'sessions.create': (p) => createFromApp(p),
    'sessions.start': (p) =>
      p.mode === 'view' ? view(str(p, 'sessionId')) : start(str(p, 'sessionId'), false),
    'sessions.retryLaunch': (p) => start(str(p, 'sessionId'), true),
    'sessions.discardLaunch': async (p) => {
      const id = str(p, 'sessionId');
      const f = factsOf(id);
      if (f.spawn === 'unconfirmed' && f.launchId) {
        await runtime.discardLaunch(id, f.launchId);
        setFacts(id, { spawn: 'none' });
        mgr.setStatus(id, 'stale');
      }
      return {};
    },
    'sessions.restart': (p) => restart(str(p, 'sessionId')),
    'sessions.relaunch': (p) => relaunch(p.sessionIds),
    'sessions.remove': async (p) => {
      await closeSession(str(p, 'sessionId'));
      return {};
    },
    'sessions.duplicate': (p) => {
      const id = str(p, 'sessionId');
      const d = roleBriefs.beginDuplicate(id);
      const dup = mgr.duplicate(id, { id: d.id, ...(d.brief ? { brief: d.brief } : {}) });
      if (!dup) {
        d.rollback();
        throw new RpcFault('not_found', 'Session no longer exists');
      }
      void folders.check(dup.id);
      return { sessionId: dup.id };
    },
    'sessions.mutate': (p) => mutate(str(p, 'sessionId'), p.mutation as SessionMutation),
    'sessions.reorder': (p) => {
      if (Array.isArray(p.order))
        mgr.reorder(p.order.filter((x): x is string => typeof x === 'string'));
      return {};
    },
    'sessions.addDirs': (p) => addDirs(str(p, 'sessionId')),
    'sessions.dismissScope': (p) => {
      scopes.dismiss(str(p, 'sessionId'));
      return {};
    },
    'sessions.probeFolders': async (p) => ({
      results: await probeFolders(Array.isArray(p.paths) ? p.paths : [], {
        probe: (raw) => probeFolder(raw, probeDeps),
        gitInfo: (d) => getGitInfo(d, { timeoutMs: GIT_TIMEOUT.metadata }),
      }),
    }),
    'projects.create': (p) => {
      if (!projectsAvailable()) throw new RpcFault('unavailable', 'store-unavailable');
      const created = projectStore.create(p.name);
      if (!created) throw new RpcFault('invalid', 'invalid-name');
      return { id: created.id };
    },
    'projects.rename': (p) => {
      if (!projectsAvailable()) throw new RpcFault('unavailable', 'store-unavailable');
      if (!projectStore.rename(str(p, 'id'), p.name)) throw new RpcFault('invalid', 'invalid-name');
      return {};
    },
    'projects.delete': (p) => {
      if (!projectsAvailable()) throw new RpcFault('unavailable', 'store-unavailable');
      const id = str(p, 'id');
      if (projectStore.delete(id)) mgr.clearProject(id);
      return {};
    },
    'projects.reorder': (p) => {
      if (!projectsAvailable()) throw new RpcFault('unavailable', 'store-unavailable');
      if (!projectStore.reorder(p.ids)) throw new RpcFault('invalid', 'Bad project order');
      return {};
    },
    'launchers.rescan': () => {
      if (launcherHost.rescan()) launchersChanged();
      return {};
    },
    'launchers.addCustom': (p) => {
      const r = launcherHost.addCustom(p.commandLine, p.label);
      if (!r.ok) return { error: r.error };
      launchersChanged();
      return { id: r.id };
    },
    'launchers.removeCustom': (p) => {
      if (launcherHost.removeCustom(p.id)) launchersChanged();
      return {};
    },
    'launchers.preview': (p) =>
      previewLaunch(
        { agentId: p.agentId, home: p.home, roots: p.roots, brief: p.brief },
        {
          registry,
          probe: (raw) => probeFolder(raw, probeDeps),
          resolveInitialRoots: (h, r) => sessionOps.resolveInitialRoots(h, r),
          exists: existsSync,
          resolveCommand,
          platform: hostPlatform,
          userData,
          e2e: deps.e2e,
        },
      ),
    'briefs.probe': async (p) => {
      const r = await roleBriefs.probe(p.path);
      return r.ok ? { ok: true, bytes: r.bytes } : { ok: false, error: r.error };
    },
    'briefs.agentPreview': (p) =>
      roleBriefs.agentPreview(typeof p.agentId === 'string' ? registry.get(p.agentId) : undefined),
    'timers.set': (p) => {
      const res = timers.set(p.schedule as Parameters<Scheduler['set']>[0]);
      return res.ok ? {} : { error: { message: res.error } };
    },
    'timers.offer': (p) => {
      // Resolved once, here: two windows answering one offer produce one schedule.
      monitor.answerOffer(str(p, 'sessionId'), p.action === 'arm' ? 'arm' : 'dismiss');
      timersChanged();
      return {};
    },
    'timers.cancel': (p) => {
      timers.cancel(str(p, 'id'), 'cancelled by the human');
      return {};
    },
    'scheduler.setSessionAutoResume': (p) => {
      const mode = p.mode;
      if (mode !== 'inherit' && mode !== 'on' && mode !== 'off')
        throw new RpcFault('refused', 'mode must be inherit, on or off');
      if (!mgr.setAutoResume(str(p, 'sessionId'), mode as SessionAutoResume))
        throw new RpcFault('not_found', 'Session no longer exists');
      monitor.onModeChanged();
      return {};
    },
    'scheduler.history': (p) => ({
      jobs: timers.history(str(p, 'sessionId')),
      episodes: monitor.episodes().filter((e) => e.sessionId === str(p, 'sessionId')),
    }),
    'timers.renew': (p) => {
      const res = timers.renewSchedule(str(p, 'id'));
      if (!res.ok) throw new RpcFault('refused', res.error);
      return {};
    },
    'timers.sendNow': async (p) => {
      if (!(await timers.sendNow(str(p, 'id'))))
        throw new RpcFault('refused', "That session isn't running.");
      return {};
    },
    'timers.sendOnce': async (p) => {
      const sent = await timers.sendOnce(
        str(p, 'sessionId'),
        typeof p.message === 'string' ? p.message : '',
      );
      if (!sent) throw new RpcFault('refused', "Nothing sent — that session isn't running.");
      return {};
    },
    'timers.test': (p) => {
      if (!deps.e2e) throw new RpcFault('refused', 'timers.test needs --e2e');
      if (p.op === 'advance' && typeof p.ms === 'number') timers.advanceClock(p.ms);
      return {};
    },
    'serverSettings.patch': (p) => {
      if (settingsStore.patch(p.patch)) {
        deps.emit('serverSettings.changed', { settings: settings() });
        monitor.onModeChanged();
        // A setting decides what D40 writes.
        schedulePersist('sessions');
      }
      return { settings: settings() };
    },
    'folders.suspect': async (p) => {
      await folders.suspect(str(p, 'sessionId'), str(p, 'path'));
      return {};
    },
    'system.resumed': () => {
      // Timers armed before a suspend fire late or not at all; due schedules go out now.
      timers.evaluate();
      return {};
    },
  };

  function handle(request: RpcRequest): Promise<RpcAnswer> | undefined {
    const table: Record<string, Handler<unknown>> = methods;
    const method = Object.hasOwn(table, request.method) ? table[request.method] : undefined;
    if (!method) return undefined;
    const params =
      typeof request.params === 'object' &&
      request.params !== null &&
      !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    return (async () => {
      try {
        return { result: await method(params) };
      } catch (error) {
        return { error };
      }
    })();
  }

  const sessions: SessionStorePort = {
    get: (id) => mgr.get(id),
    list: () => mgr.list(),
    setMcp: (id, patch) => mgr.setMcp(id, patch),
    setMcpToolPolicy: (id, tool, patch) => mgr.setMcpToolPolicy(id, tool, patch),
    touch: (id, minIntervalMs) => mgr.touch(id, minIntervalMs),
    setStatus: (id, value) => mgr.setStatus(id, value),
    onChange: (listener) => mgr.onChange(listener),
    allocateLaunch,
  };

  const domain: DomainPort = {
    bracketedPaste: (id) => !!pasteModes.get(id)?.on,
    limitRules: () => rules.current(),
    homeOf: (id) => mgr.get(id)?.home,
    resolvePath: (home, target) => resolve(home, target),
    kindOf: (target) =>
      fsp.stat(target).then(
        (st) => (st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'),
        () => 'missing' as const,
      ),
    agentIds: () => registry.list().map((d) => d.id),
    agentCatalog: () => {
      const kinds = new Map(launcherHost.dtos().map((d) => [d.id, d.kind]));
      return registry.list().flatMap((def) => {
        const kind = kinds.get(def.id);
        return kind === undefined ? [] : [{ def, source: SOURCE_OF_LAUNCHER[kind] }];
      });
    },
    resolveCommand,
    foldersOf: (id) => {
      const s = mgr.get(id);
      return s ? { home: s.home, roots: [...s.roots] } : undefined;
    },
    addRoot: (id, target) => sessionOps.addRoot(id, target),
    git: (cwd, args) =>
      runGit(args, { cwd, timeoutMs: GIT_TIMEOUT.metadata }).then((r) => ({
        ok: r.ok,
        stdout: r.stdout,
        stderr: r.stderr,
      })),
    openSession,
    closeSession: (id, opts) => {
      log.info('session', 'close', { sessionId: id, closedBy: opts.closedBy });
      return closeSession(id);
    },
    defOf: (id) => {
      const s = mgr.get(id);
      return s ? effectiveDef(s, registry) : undefined;
    },
    agentDef: (id) => registry.get(id),
    projectName: (id) => (id ? (projectStore.list().find((p) => p.id === id)?.name ?? null) : null),
    installState: (cli) => deps.installState(cli),
    messagingOn: () => settings().conduitMcp,
    toolPolicy: () => ({ global: settings().mcpToolPolicy, byCli: settings().mcpToolPolicyByCli }),
  };

  const flush = (what: keyof typeof writers) => {
    clearTimeout(persistTimers.get(what));
    persistTimers.delete(what);
    const text = writers[what]();
    if (text !== null) writeSync(fileOf[what], text);
  };

  return {
    handle,
    sessions,
    domain,
    adopted,
    presence: (windows) => folders.presence(windows),
    reloadAgents,
    resized: (id, size) => {
      if (mgr.get(id)) requestedSizes.set(id, size);
    },
    snapshot: () => ({
      sessions: views(),
      settings: settings(),
      stores: {
        agents: registry.list(),
        launchers: launcherHost.dtos(),
        projects: projectStore.list(),
      },
      timers: timersState(),
    }),
    settings,
    // A verify window must outlive an idle shutdown too; a proposal waits on a human, not a timer.
    pendingTimers: () =>
      timers
        .list()
        .some(
          (j) =>
            ['armed', 'checking', 'sending', 'verifying'].includes(j.state) ||
            (j.state === 'waiting' && isLive(j.sessionId)),
        ),
    hookPost: (sessionId: string, post: HookPost) => {
      for (const signal of claudeSignalsFromHook(sessionId, post.event, post.payload, Date.now()))
        monitor.signal(signal);
    },
    humanInput: (sessionId: string) => monitor.onHumanInput(sessionId),
    persist: async () => {
      flush('sessions');
      flush('timers');
      flush('projects');
      const launchers = launcherHost.pendingFlush();
      if (launchers !== null) writeSync('launchers.json', launchers);
    },
    dispose: async () => {
      unsubscribe();
      timers.stop();
      monitor.dispose();
      codexWatch.dispose();
      rules.dispose();
      unwatchBusy();
      folders.dispose();
      clearTimeout(timersChangedTimer);
      for (const t of persistTimers.values()) clearTimeout(t);
      persistTimers.clear();
      await Promise.all(pendingWrites);
    },
  };
}

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);
