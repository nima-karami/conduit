// The one spawn resolution `term:start` launches from (mf-model spec §2.5).
import * as path from 'node:path';
import { launchArgsFor } from './launch-args';
import type { HostPlatform } from './lsp-binary';
import type { AgentDefinition, SpawnSpec } from './types';

export interface LaunchRequest {
  /** effectiveDef of the session; undefined launches the default shell. */
  def: AgentDefinition | undefined;
  cwd: string | undefined;
  home: string;
  homeMissing: boolean;
  roots: readonly string[];
  exists: (p: string) => boolean;
  resolveCommand: (command: string) => string | undefined;
  platform: HostPlatform;
}

export type LaunchPlan =
  | {
      ok: true;
      spec: SpawnSpec;
      addDir: boolean;
      launchedRoots: string[];
      skippedAddDirRoots: string[];
    }
  | { ok: false; reason: 'home-missing' }
  | { ok: false; reason: 'unresolvable'; command: string };

export function buildLaunchSpec(req: LaunchRequest): LaunchPlan {
  if (req.homeMissing) return { ok: false, reason: 'home-missing' };
  const dir =
    req.cwd && req.exists(req.cwd) ? req.cwd : req.exists(req.home) ? req.home : undefined;
  if (dir === undefined) return { ok: false, reason: 'home-missing' };
  const spec = resolveLaunchSpec(req.def, dir, req.exists, dir);
  const { def } = req;
  if (!def) return { ok: true, spec, addDir: false, launchedRoots: [], skippedAddDirRoots: [] };
  // node-pty on win32 neither walks PATHEXT nor finds a `.cmd` by its bare name, so a raw
  // agents.json `claude` fails "File not found" (QA F1): spawn only what was resolved.
  const command = req.resolveCommand(def.command);
  if (command === undefined) return { ok: false, reason: 'unresolvable', command: def.command };
  const { args, ...lists } = launchArgsFor(def, req.roots, {
    platform: req.platform,
    resolvedCommand: command,
  });
  return { ok: true, spec: { ...spec, command, args }, ...lists };
}

// Prefixes that identify editor-injected environment variables.
const EDITOR_PREFIXES = ['VSCODE_', 'CURSOR_'];

/**
 * Return a copy of `parentEnv` with editor-identity vars removed so that child
 * PTY processes do not inherit them and mistakenly believe they are running
 * inside VS Code or Cursor.
 *
 * When Conduit is launched from Cursor or VS Code, the parent process injects
 * vars like TERM_PROGRAM=vscode and keys prefixed with VSCODE_ or CURSOR_ into
 * the environment. Tools running in the terminal (e.g. the Claude Code CLI)
 * inspect these vars to detect their host editor, so leaking them causes
 * incorrect editor detection. Conduit itself never reads any of these vars.
 *
 * Stripped unconditionally:
 *   - TERM_PROGRAM, TERM_PROGRAM_VERSION
 *   - All keys starting with VSCODE_ or CURSOR_
 *   - CONDUIT_SESSION_TOKEN and CONDUIT_MCP_ENDPOINT: see docs/specs/2026-10-26-conduit-mcp-cursor.md §3.2.
 *
 * Stripped conditionally (only when editor-prefix vars are present):
 *   - GIT_ASKPASS: editors inject their own askpass shim, which arrives via the
 *     VSCODE_GIT_ASKPASS_* keys. The generic GIT_ASKPASS is stripped alongside
 *     those editor keys to remove the shim path without clobbering a
 *     user-configured askpass in an otherwise clean environment.
 *
 * Everything else (PATH, HOME, user-set vars, etc.) is kept intact.
 */
export function sanitizeChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hasEditorVars = Object.keys(parentEnv).some((k) =>
    EDITOR_PREFIXES.some((p) => k.startsWith(p)),
  );
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (EDITOR_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') continue;
    if (key === 'CONDUIT_SESSION_TOKEN') continue;
    if (key === 'CONDUIT_MCP_ENDPOINT') continue;
    if (key === 'GIT_ASKPASS' && hasEditorVars) continue;
    result[key] = value;
  }
  return result;
}

/** Default shell spec for a given working directory. */
function defaultShellSpec(cwd: string): SpawnSpec {
  const isWin = process.platform === 'win32';
  const command = isWin
    ? process.env.ComSpec || 'powershell.exe'
    : process.env.SHELL || '/bin/bash';
  // $SHELL is the user's login shell, so -l/-i is safe here and makes the
  // fallback source profile files just like the detected shells (see shells.ts) —
  // except sh/dash/ash (busybox, Alpine minimal images), which reject -l and have
  // no profile to source, same reason shells.ts's own sh candidate carries no args.
  const noLogin = isWin || /^(sh|dash|ash)$/.test(path.basename(command));
  return { command, args: noLogin ? [] : ['-i', '-l'], cwd };
}

/**
 * Decide what to launch in a session's terminal: its resolved definition in its folder, or a
 * plain shell when there is none; `fallbackCwd` when the requested cwd is missing or gone.
 * The caller resolves the definition (effectiveDef, spec 2026-10-27-conduit-mcp-control-tools §3.3).
 */
export function resolveLaunchSpec(
  def: AgentDefinition | undefined,
  cwd: string | undefined,
  cwdExists: (p: string) => boolean,
  fallbackCwd: string,
): SpawnSpec {
  const dir = cwd && cwdExists(cwd) ? cwd : fallbackCwd;
  return def ? { command: def.command, args: [...def.args], cwd: dir } : defaultShellSpec(dir);
}
