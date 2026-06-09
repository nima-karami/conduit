import * as os from 'os';
import * as pty from 'node-pty';
import { SpawnSpec } from './types';
import { HostToWebview } from './protocol';
import { AgentRegistry } from './agentRegistry';

/**
 * Owns the node-pty processes, one per session, and bridges their I/O to the
 * webview. This is the only place that touches node-pty.
 */
export class PtyHost {
  private readonly procs = new Map<string, pty.IPty>();

  constructor(private readonly send: (msg: HostToWebview) => void) {}

  start(sessionId: string, cols: number, rows: number, spec: SpawnSpec) {
    if (this.procs.has(sessionId)) return;
    const proc = pty.spawn(spec.command, spec.args, {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: spec.cwd || os.homedir(),
      env: { ...process.env, ...spec.env },
    });
    proc.onData((data) => this.send({ type: 'term:data', sessionId, data }));
    proc.onExit(({ exitCode }) => {
      this.procs.delete(sessionId);
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
export function defaultShellSpec(cwd: string): SpawnSpec {
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
