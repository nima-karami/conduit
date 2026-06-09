import * as os from 'os';
import * as pty from 'node-pty';
import { SpawnSpec } from './types';
import { HostToWebview } from './protocol';

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
