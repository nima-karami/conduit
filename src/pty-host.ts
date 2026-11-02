import * as os from 'node:os';
import * as pty from '@lydell/node-pty';
import { lastNonEmptyLine, lastNonEmptyLines } from './last-line';
import { sanitizeChildEnv } from './launch-spec';
import type { HostToWebview, TermGeometry } from './protocol';
import { appendScrollback } from './scrollback-persistence';
import type { SpawnSpec } from './types';

/**
 * Trailing PTY bytes kept per session to derive `lastLine`. Small on purpose: this is a
 * subtitle, not scrollback (that ring is 256 KiB and only exists when the persistence
 * setting is on — `lastLine` must work regardless).
 */
const TAIL_BYTES = 4096;

/**
 * Owns the node-pty processes, one per session, and bridges their I/O to the
 * webview. This is the only place that touches node-pty.
 */
export class PtyHost {
  private readonly procs = new Map<string, { proc: pty.IPty; gen: number; size: TermGeometry }>();
  // Killed by a restart but not exited yet: still ours to kill on quit, no longer "alive", and
  // its exit is silent — see mf-live-edits spec §2.4 R1.
  private readonly retired = new Set<pty.IPty>();
  private nextGen = 1;
  // Rolling tail per session + its memoized last line, invalidated on new output so a
  // repeated broadcast with no output in between costs nothing.
  private readonly tails = new Map<string, string>();
  private readonly lastLines = new Map<string, string>();

  constructor(
    private readonly send: (msg: HostToWebview) => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  start(sessionId: string, cols: number, rows: number, spec: SpawnSpec) {
    if (this.procs.has(sessionId)) {
      this.log(`start ignored; session ${sessionId} already running`);
      return;
    }
    // A relaunch reuses the session id, and the tail survives term:exit on purpose (an exited
    // session's card keeps its last line). It must NOT survive into the NEW child: the limit
    // detector reads this buffer, so the previous agent's "resets 11:10pm" would otherwise be
    // the first thing scanned against a fresh bare shell and arm a Continue into it — the exact
    // situation spec 2026-08-28-timed-messages §12.1 says the host never manufactures.
    this.tails.delete(sessionId);
    this.lastLines.delete(sessionId);
    const cwd = spec.cwd || os.homedir();
    this.log(`spawn "${spec.command}" ${JSON.stringify(spec.args)} in ${cwd} (${cols}x${rows})`);
    let proc: pty.IPty;
    const size: TermGeometry = { cols: cols || 80, rows: rows || 24 };
    try {
      proc = pty.spawn(spec.command, spec.args, {
        name: 'xterm-color',
        ...size,
        cwd,
        env: { ...sanitizeChildEnv(process.env), ...spec.env },
      });
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
    const gen = this.nextGen++;
    const current = () => this.procs.get(sessionId)?.proc === proc;
    proc.onData((data) => {
      if (!current()) return;
      this.tails.set(
        sessionId,
        appendScrollback(this.tails.get(sessionId) ?? '', data, TAIL_BYTES),
      );
      this.lastLines.delete(sessionId);
      this.send({ type: 'term:data', sessionId, data });
    });
    proc.onExit(({ exitCode }) => {
      if (this.retired.delete(proc)) {
        this.log(`session ${sessionId} retired child exited (${exitCode})`);
        return;
      }
      const entry = this.procs.get(sessionId);
      if (entry && entry.proc !== proc) {
        this.log(`session ${sessionId} stale exit ignored (${exitCode})`);
        return;
      }
      // No entry = disposed: the term:exit still goes out, disposeSession relies on it.
      if (entry) this.procs.delete(sessionId);
      this.log(`session ${sessionId} exited (${exitCode})`);
      this.send({ type: 'term:exit', sessionId, code: exitCode });
    });
    this.procs.set(sessionId, { proc, gen, size });
  }

  /**
   * True when a live PTY process exists for `sessionId`. Used by the host's `term:start`
   * to distinguish a cold start (spawn) from an ATTACH — a window mounting a pane for an
   * already-running session (multi-window Slice B session move). `procs` stays private.
   */
  isAlive(sessionId: string): boolean {
    return this.procs.has(sessionId);
  }

  /** The current child's generation; a write bound to one is void once it changes (R1). */
  generation(sessionId: string): number | undefined {
    return this.procs.get(sessionId)?.gen;
  }

  /** Kill the current child and detach it so the next `start` spawns at once (spec §2.4). */
  retire(sessionId: string): boolean {
    const entry = this.procs.get(sessionId);
    if (!entry) return false;
    this.procs.delete(sessionId);
    this.retired.add(entry.proc);
    try {
      entry.proc.kill();
    } catch {
      /* already gone — its exit, if one still comes, is silent */
    }
    return true;
  }

  /**
   * The session's live card subtitle (D6): the last non-empty line it printed. Survives
   * `term:exit` — an exited session's final line is exactly what its card should still
   * say — and is dropped only when the session is disposed. '' when nothing was printed.
   */
  lastLine(sessionId: string): string {
    const cached = this.lastLines.get(sessionId);
    if (cached !== undefined) return cached;
    const derived = lastNonEmptyLine(this.tails.get(sessionId) ?? '');
    this.lastLines.set(sessionId, derived);
    return derived;
  }

  /**
   * The session's last `n` non-empty output lines — the same tail `lastLine` reads, no new
   * per-session state. The limit detector (src/limit-notice.ts) matches against THIS rather
   * than the stream, so a notice that scrolled past inside a diff is not a match.
   */
  tailLines(sessionId: string, n: number): string[] {
    return lastNonEmptyLines(this.tails.get(sessionId) ?? '', n);
  }

  /**
   * Write into a session's PTY. Returns whether a LIVE process took it — the scheduled-fire
   * path derives `delivered` from this rather than asserting it around a void call (spec
   * 2026-08-28-timed-messages §2 "Delivery"). `term:input` ignores the return.
   */
  input(sessionId: string, data: string): boolean {
    const entry = this.procs.get(sessionId);
    if (!entry) return false;
    entry.proc.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number) {
    const entry = this.procs.get(sessionId);
    if (!entry) return;
    const size = { cols: Math.max(cols, 1), rows: Math.max(rows, 1) };
    try {
      entry.proc.resize(size.cols, size.rows);
      entry.size = size;
    } catch {
      /* resize can throw if the process is gone — ignore */
    }
  }

  /** The live PTY's size — what the output it is sending now is addressed at. */
  size(sessionId: string): TermGeometry | undefined {
    return this.procs.get(sessionId)?.size;
  }

  dispose(sessionId: string) {
    this.procs.get(sessionId)?.proc.kill();
    this.procs.delete(sessionId);
    this.tails.delete(sessionId);
    this.lastLines.delete(sessionId);
  }

  disposeAll() {
    for (const p of [...[...this.procs.values()].map((e) => e.proc), ...this.retired]) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    this.procs.clear();
    this.retired.clear();
    this.tails.clear();
    this.lastLines.clear();
  }
}
