import * as inspector from 'node:inspector';
import * as os from 'node:os';
import * as pty from '@lydell/node-pty';
import type { AgentRegistry } from './agent-registry';
import type { HostToWebview } from './protocol';
import type { SpawnSpec } from './types';

/**
 * True when a Node inspector/debugger is attached (e.g. launched via F5).
 * node-pty's ConPTY backend hangs/crashes `spawn` under the debugger on Windows
 * (microsoft/node-pty#640), so we fall back to winpty in that case.
 */
function isDebuggerAttached(): boolean {
  try {
    return !!inspector.url();
  } catch {
    return false;
  }
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
    if (key === 'GIT_ASKPASS' && hasEditorVars) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Owns the node-pty processes, one per session, and bridges their I/O to the
 * webview. This is the only place that touches node-pty.
 */
export class PtyHost {
  private readonly procs = new Map<string, pty.IPty>();

  constructor(
    private readonly send: (msg: HostToWebview) => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  start(sessionId: string, cols: number, rows: number, spec: SpawnSpec, startupInput?: string) {
    if (this.procs.has(sessionId)) {
      this.log(`start ignored; session ${sessionId} already running`);
      return;
    }
    const cwd = spec.cwd || os.homedir();
    // ConPTY hangs under the debugger on Windows (node-pty#640) — use winpty then.
    const useConpty = !(process.platform === 'win32' && isDebuggerAttached());
    this.log(
      `spawn "${spec.command}" ${JSON.stringify(spec.args)} in ${cwd} (${cols}x${rows}) useConpty=${useConpty}`,
    );
    let proc: pty.IPty;
    try {
      const opts: Record<string, unknown> = {
        name: 'xterm-color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env: { ...sanitizeChildEnv(process.env), ...spec.env },
      };
      if (process.platform === 'win32') opts.useConpty = useConpty;
      proc = pty.spawn(spec.command, spec.args, opts as pty.IPtyForkOptions);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`spawn FAILED: ${message}`);
      // Surface the failure inside the terminal so it isn't silently empty.
      this.send({
        type: 'term:data',
        sessionId,
        data: `\r\n\x1b[31m[conduit] failed to launch "${spec.command}": ${message}\x1b[0m\r\n`,
      });
      return;
    }
    // Deferred startup input (the PowerShell cwd hook): write it only once the shell
    // has produced output — i.e. it's past the fragile startup window where a fresh
    // Windows PowerShell is killed (STATUS_CONTROL_C_EXIT) by anything touching it
    // mid-init. A short settle after first data lets the first prompt finish drawing.
    let startupInputSent = false;
    proc.onData((data) => {
      this.send({ type: 'term:data', sessionId, data });
      if (startupInput && !startupInputSent) {
        startupInputSent = true;
        setTimeout(() => this.procs.get(sessionId)?.write(startupInput), 250);
      }
    });
    proc.onExit(({ exitCode }) => {
      this.procs.delete(sessionId);
      this.log(`session ${sessionId} exited (${exitCode})`);
      this.send({ type: 'term:exit', sessionId, code: exitCode });
    });
    this.procs.set(sessionId, proc);
  }

  input(sessionId: string, data: string) {
    this.procs.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number) {
    try {
      this.procs.get(sessionId)?.resize(Math.max(cols, 1), Math.max(rows, 1));
    } catch {
      /* resize can throw if the process is gone — ignore */
    }
  }

  dispose(sessionId: string) {
    this.procs.get(sessionId)?.kill();
    this.procs.delete(sessionId);
  }

  disposeAll() {
    for (const p of this.procs.values()) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    this.procs.clear();
  }
}

/** Default shell spec for a given working directory. */
function defaultShellSpec(cwd: string): SpawnSpec {
  const isWin = process.platform === 'win32';
  const command = isWin
    ? process.env.ComSpec || 'powershell.exe'
    : process.env.SHELL || '/bin/bash';
  return { command, args: [], cwd };
}

/**
 * Decide what to launch in a session's terminal: the session's configured agent
 * (resolved via the registry) in its project folder. Falls back to a plain shell
 * when the agent is unknown or is the special id 'shell'; falls back to
 * `fallbackCwd` when the requested cwd is missing or doesn't exist.
 *
 * Pure (filesystem check injected) so it can be unit-tested without VS Code.
 */
export function resolveLaunchSpec(
  registry: AgentRegistry,
  agentId: string | undefined,
  cwd: string | undefined,
  cwdExists: (p: string) => boolean,
  fallbackCwd: string,
): SpawnSpec {
  const dir = cwd && cwdExists(cwd) ? cwd : fallbackCwd;
  if (agentId && agentId !== 'shell') {
    try {
      return registry.resolve(agentId, dir);
    } catch {
      /* unknown agent — fall through to a shell */
    }
  }
  return defaultShellSpec(dir);
}
