import * as fs from 'node:fs';
import * as path from 'node:path';
import { wiresLaunch } from '../src/conduit-mcp/cursor-config';
import {
  type ConduitEntry,
  classifyEntry,
  conduitEntry,
  deepEqualConfig,
  type EntryClass,
  entryTargets,
  retargetEntry,
} from '../src/conduit-mcp/install-entries';
import {
  AGENT_CLIS,
  type AgentCli,
  type CliInstallStatus,
  type CodexEntry,
  ConfigFormatError,
  type McpInstallRequest,
  type McpInstallResult,
  type McpInstallStatus,
  type ProjectEntry,
  type ProjectInstall,
  type UserInstall,
  type UserInstallState,
} from '../src/conduit-mcp/install-types';
import {
  deletePath,
  getPath,
  type JsonObject,
  parseJsonConfig,
  serializeJsonConfig,
  setPath,
} from '../src/conduit-mcp/json-config';
import {
  locateConduitTable,
  readCodexConduit,
  spliceConduitTable,
  spliceRepairedTable,
} from '../src/conduit-mcp/toml-config';
import {
  backupOnce,
  type ConfigIo,
  type ConfigRead,
  errorCodeOf,
  readConfigFile,
  writeConfigAtomic,
} from './config-file-io';
import {
  type ConfigTarget,
  claudeLocalTarget,
  foundMarkers,
  installableInProject,
  openCodeJsoncPath,
  projectTarget,
  type TargetEnv,
  userTarget,
} from './mcp-install-targets';

export interface McpInstallDeps extends TargetEnv {
  execPath: string;
  shimPath: string;
  /** Any of CLI_BINARIES[cli] resolves on PATH. */
  onPath(cli: AgentCli): boolean;
  /** The project root equal (folderKey) to projectPath, or null: no arbitrary-path oracle (spec §3.6). */
  knownHome(projectPath: string): string | null;
  io?: ConfigIo;
}

export interface McpInstall {
  status(projectPath: string | null): McpInstallStatus;
  act(req: McpInstallRequest): McpInstallResult;
  userState(cli: AgentCli): UserInstallState;
  /** Rewrites dead other-conduit user entries (spec §14 D2); one row per rewrite or failure. */
  repair(): { cli: AgentCli; path: string; errorCode?: string }[];
}

/** What an action writes: our entry, nothing (delete), or the user's entry repointed (Repair). */
type Edit =
  | { kind: 'set'; value: ConduitEntry }
  | { kind: 'delete' }
  | { kind: 'retarget'; value: Record<string, unknown> };
/** The action's state check over the file as read: the edit, null for nothing to do, or throws ESTATE. */
type Decide = (loaded: Loaded) => Edit | null;

/** A config file read and parsed once; `json` only for JSON targets. */
interface Loaded {
  read: ConfigRead;
  json: JsonObject | null;
  entry: unknown;
}

const BOM = String.fromCharCode(0xfeff);

/** Carries its code as `code`, so errorCodeOf reports it like an OS error. */
class ActionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function createMcpInstall(deps: McpInstallDeps): McpInstall {
  const io = deps.io ?? fs;
  const expected = (cli: AgentCli): ConduitEntry => conduitEntry(cli, deps.execPath, deps.shimPath);

  function parse(target: ConfigTarget, read: ConfigRead): Loaded {
    const text = read.text ?? '';
    if (target.format === 'json') {
      const json = parseJsonConfig(text);
      return { read, json, entry: getPath(json, target.keys) };
    }
    const entry = readCodexConduit(text);
    if (entry !== undefined && locateConduitTable(text).kind === 'uneditable') {
      throw new ConfigFormatError(
        'EUNEDITABLE',
        'conduit is defined in a form Conduit cannot edit',
      );
    }
    return { read, json: null, entry };
  }

  const load = (target: ConfigTarget): Loaded => parse(target, readConfigFile(io, target.path));

  function loadUser(cli: AgentCli, target: ConfigTarget): Loaded {
    if (cli === 'opencode' && io.existsSync(openCodeJsoncPath(deps))) {
      throw new ConfigFormatError(
        'EJSONC',
        'opencode.jsonc is present; Conduit edits strict JSON only',
      );
    }
    return load(target);
  }

  const isFound = (cli: AgentCli): boolean =>
    deps.onPath(cli) || foundMarkers(cli, deps).some((p) => io.existsSync(p));

  type UserRead =
    | { target: ConfigTarget; loaded: Loaded }
    | { target: ConfigTarget; error: unknown };
  function readUser(cli: AgentCli): UserRead {
    const target = userTarget(cli, deps);
    try {
      return { target, loaded: loadUser(cli, target) };
    } catch (error) {
      return { target, error };
    }
  }

  const USER_STATE: Readonly<Record<EntryClass, UserInstallState>> = {
    absent: 'not-installed',
    ours: 'installed',
    'other-conduit': 'other-conduit',
    conflict: 'conflict',
  };

  function userInstallOf(cli: AgentCli, u: UserRead): UserInstall {
    if ('error' in u)
      return { state: 'error', path: u.target.path, errorCode: errorCodeOf(u.error) };
    return {
      state: USER_STATE[classifyEntry(cli, u.loaded.entry, expected(cli))],
      path: u.target.path,
    };
  }

  function projectEntryOf(
    cli: AgentCli,
    target: ConfigTarget,
    read: () => Loaded,
  ): ProjectEntry | null {
    let loaded: Loaded;
    try {
      loaded = read();
    } catch (error) {
      return {
        scope: projectScopeOf(target),
        state: 'error',
        path: target.path,
        errorCode: errorCodeOf(error),
      };
    }
    const cls = classifyEntry(cli, loaded.entry, expected(cli));
    if (cls === 'absent') return null;
    return { scope: projectScopeOf(target), state: cls, path: target.path };
  }

  // Claude local scope lives inside the user file: it is resolved from the parse already made for
  // the user row, so a multi-MB ~/.claude.json is read once per status (plan amendment S4).
  function projectInstallOf(cli: AgentCli, root: string, user: UserRead | null): ProjectInstall {
    const entries: ProjectEntry[] = [];
    if (cli === 'claude' && user !== null && 'loaded' in user && user.loaded.json !== null) {
      const json = user.loaded.json;
      const local = claudeLocalTarget(root, json, deps);
      if (local) {
        const e = projectEntryOf(cli, local, () => ({
          ...user.loaded,
          entry: getPath(json, local.keys),
        }));
        if (e) entries.push(e);
      }
    }
    const target = projectTarget(cli, root, deps);
    const e = projectEntryOf(cli, target, () => load(target));
    if (e) entries.push(e);
    const installable = installableInProject(cli) && !entries.some((x) => x.scope === 'project');
    return { entries, installable, installPath: installable ? target.path : null };
  }

  function cliStatus(cli: AgentCli, root: string | null): CliInstallStatus {
    const found = isFound(cli);
    const user = found ? readUser(cli) : null;
    const userInstall: UserInstall = user
      ? userInstallOf(cli, user)
      : { state: 'not-found', path: userTarget(cli, deps).path };
    const project = root === null ? null : projectInstallOf(cli, root, user);
    // Claude and Codex give a project/local entry precedence over the user one (spec §2.3).
    if (project && (cli === 'claude' || cli === 'codex')) {
      const shadow = project.entries.find((e) => e.state !== 'ours');
      if (shadow) userInstall.shadowedBy = shadow.scope;
    }
    return { cli, found, user: userInstall, project };
  }

  const rootOf = (projectPath: string | null): string | null =>
    projectPath === null ? null : deps.knownHome(projectPath);

  function render(target: ConfigTarget, loaded: Loaded, edit: Edit): string {
    if (target.format === 'json') {
      const json = loaded.json ?? {};
      return serializeJsonConfig(
        edit.kind === 'delete'
          ? deletePath(json, target.keys)
          : setPath(json, target.keys, edit.value),
      );
    }
    // TOML is spliced, not re-serialized, so the user's bytes (and BOM) outside our table survive.
    const text = loaded.read.text ?? '';
    const out =
      edit.kind === 'retarget'
        ? spliceRepairedTable(text, edit.value)
        : spliceConduitTable(text, edit.kind === 'delete' ? null : (edit.value as CodexEntry));
    return loaded.read.bom ? BOM + out : out;
  }

  function unchangedSince(read: ConfigRead): boolean {
    let st: fs.Stats;
    try {
      st = io.statSync(read.realPath);
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return read.text === null;
      throw error;
    }
    return read.text !== null && st.mtimeMs === read.mtimeMs && st.size === read.size;
  }

  // spec §3.5 step 4 (D1): a running Claude rewrites ~/.claude.json; re-apply once over its write,
  // then give up rather than clobber it. The re-apply re-runs the state check: that writer may have
  // changed conduit itself (`claude mcp add conduit …`). Returns whether it wrote.
  function writeEntry(target: ConfigTarget, first: Loaded, decide: Decide): boolean {
    let loaded = first;
    let edit = decide(loaded);
    if (edit === null) return false;
    let data = render(target, loaded, edit);
    backupOnce(io, target.backupPath, loaded.read.raw);
    if (target.mtimeGuard && !unchangedSince(loaded.read)) {
      loaded = load(target);
      edit = decide(loaded);
      if (edit === null) return false;
      data = render(target, loaded, edit);
      if (!unchangedSince(loaded.read)) throw new ActionError('EBUSY');
    }
    writeConfigAtomic(io, loaded.read.realPath, data, loaded.read.mode);
    return true;
  }

  const classOf = (cli: AgentCli, loaded: Loaded) =>
    classifyEntry(cli, loaded.entry, expected(cli));

  function userAction(req: McpInstallRequest): void {
    const target = userTarget(req.cli, deps);
    const first = loadUser(req.cli, target);
    writeEntry(target, first, (loaded) => {
      const cls = classOf(req.cli, loaded);
      if (req.action === 'install' && cls === 'ours') return null;
      if (req.action === 'install' && (cls === 'absent' || cls === 'other-conduit')) {
        return { kind: 'set', value: expected(req.cli) };
      }
      // Replace applies to the conflict read when the action started, not to one written since.
      if (
        req.action === 'replace' &&
        cls === 'conflict' &&
        deepEqualConfig(loaded.entry, first.entry)
      ) {
        return { kind: 'set', value: expected(req.cli) };
      }
      if (req.action === 'uninstall' && (cls === 'ours' || cls === 'other-conduit')) {
        return { kind: 'delete' };
      }
      throw new ActionError('ESTATE');
    });
  }

  function projectAction(req: McpInstallRequest, root: string): void {
    if (req.action === 'install') {
      if (!installableInProject(req.cli)) throw new ActionError('ESTATE');
      const target = projectTarget(req.cli, root, deps);
      writeEntry(target, load(target), (loaded) => {
        if (loaded.entry !== undefined) throw new ActionError('ESTATE');
        return { kind: 'set', value: expected(req.cli) };
      });
      return;
    }
    if (req.action !== 'remove') throw new ActionError('ESTATE');
    let target: ConfigTarget | null;
    if (req.entryScope === 'local') {
      if (req.cli !== 'claude') throw new ActionError('ESTATE');
      const user = load(userTarget('claude', deps));
      target = user.json === null ? null : claudeLocalTarget(root, user.json, deps);
    } else {
      target = projectTarget(req.cli, root, deps);
    }
    if (target === null) throw new ActionError('ESTATE');
    writeEntry(target, load(target), (loaded) => {
      const cls = classOf(req.cli, loaded);
      if (cls !== 'ours' && cls !== 'other-conduit') throw new ActionError('ESTATE');
      return { kind: 'delete' };
    });
  }

  function act(req: McpInstallRequest): McpInstallResult {
    const root = req.scope === 'project' ? rootOf(req.projectPath ?? null) : null;
    const statusRoot = rootOf(req.projectPath ?? null);
    const fail = (errorCode: string): McpInstallResult => ({
      ok: false,
      status: cliStatus(req.cli, statusRoot),
      errorCode,
    });
    if (req.scope === 'project' && root === null) return fail('EPROJECT');
    if (!isFound(req.cli)) return fail('ESTATE');
    try {
      if (root === null) userAction(req);
      else projectAction(req, root);
    } catch (error) {
      return fail(errorCodeOf(error));
    }
    return { ok: true, status: cliStatus(req.cli, statusRoot) };
  }

  function userState(cli: AgentCli): UserInstallState {
    if (!isFound(cli)) return 'not-found';
    return userInstallOf(cli, readUser(cli)).state;
  }

  function isAbsolutePath(p: string): boolean {
    return deps.platform === 'win32' ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
  }

  // A bare command like "node" is resolved through PATH, not a file this build could have moved.
  const isDeadPath = (p: string | null) => p !== null && isAbsolutePath(p) && !io.existsSync(p);

  function repair(): { cli: AgentCli; path: string; errorCode?: string }[] {
    const rows: { cli: AgentCli; path: string; errorCode?: string }[] = [];
    for (const cli of AGENT_CLIS) {
      if (!isFound(cli)) continue;
      const user = readUser(cli);
      if (!('loaded' in user)) continue;
      const decide = (loaded: Loaded): Edit | null => {
        if (classOf(cli, loaded) !== 'other-conduit') return null;
        const { command, shim } = entryTargets(cli, loaded.entry);
        if (!isDeadPath(command) && !isDeadPath(shim)) return null;
        const value = retargetEntry(cli, loaded.entry, {
          ...(isDeadPath(command) ? { exe: deps.execPath } : {}),
          ...(isDeadPath(shim) ? { shim: deps.shimPath } : {}),
        });
        return value && { kind: 'retarget', value };
      };
      if (decide(user.loaded) === null) continue;
      try {
        if (writeEntry(user.target, user.loaded, decide))
          rows.push({ cli, path: user.target.path });
      } catch (error) {
        rows.push({
          cli,
          path: user.target.path,
          errorCode: errorCodeOf(error),
        });
      }
    }
    return rows;
  }

  return {
    status: (projectPath) => {
      const root = rootOf(projectPath);
      return { clis: AGENT_CLIS.map((cli) => cliStatus(cli, root)) };
    },
    act,
    userState,
    repair,
  };
}

function projectScopeOf(target: ConfigTarget): 'project' | 'local' {
  return target.scope === 'local' ? 'local' : 'project';
}

// see docs/specs/2026-10-26-conduit-mcp-cursor.md §3.3: a Cursor profile session is wired only
// when Cursor's user config forwards the session's identity; any unreadable file means it isn't.
export function readCursorLaunchEntry(homeDir: string): boolean {
  const configPath = path.join(homeDir, '.cursor', 'mcp.json');
  try {
    const json = parseJsonConfig(fs.readFileSync(fs.realpathSync(configPath), 'utf8'));
    return wiresLaunch(getPath(json, ['mcpServers', 'conduit']));
  } catch {
    return false;
  }
}
