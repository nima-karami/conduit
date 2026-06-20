import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import {
  buildDiagnosticsHeader,
  type DiagnosticsInfo,
  formatRecord,
  type LogLevel,
  type LogRecord,
  levelEnabled,
  pruneOldLogs,
  redact,
  shouldRotate,
  tailLines,
} from '../src/logging';

/** Rotate the active file once it reaches 5 MB; keep the 5 newest rolls. */
const ROTATE_CAP_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 5;

/** Bound the recent-tail surfaced in Settings→About: at most this many lines or bytes. */
const TAIL_MAX_LINES = 200;
const TAIL_MAX_BYTES = 256 * 1024;

type Scope = string;
type Level = Exclude<LogLevel, 'off'>;

/**
 * The host's sole disk-writing logger (Slice A). Each `log.<level>(scope, msg, data?)`:
 * runs a cheap level gate BEFORE formatting; redacts `data`; appends one JSONL line to a
 * rotating file under userData/logs (a temp dir under CONDUIT_E2E so the smoke suite never
 * pollutes the real profile); and, in dev only (`!app.isPackaged`), mirrors to the console.
 *
 * Writes are best-effort: a sink failure degrades to console + sets `writeDegraded` and is
 * NEVER thrown into a caller (a logging failure must never crash the app). Rotation is
 * synchronous within the write path — the host is the only writer, so no roll can race.
 */
export class Logger {
  private level: LogLevel;
  private readonly dir: string;
  private file: string;
  private bytes = 0;
  private writeDegraded = false;

  constructor(level: LogLevel) {
    this.level = level;
    // Keep the smoke suite (and any CONDUIT_E2E run) out of the real userData dir. The
    // e2e scenario reads this temp dir to assert a JSONL record was written.
    this.dir =
      process.env.CONDUIT_E2E === '1'
        ? path.join(os.tmpdir(), 'conduit-e2e-logs')
        : path.join(app.getPath('userData'), 'logs');
    this.file = path.join(this.dir, this.activeFileName());
    this.initSink();
  }

  /** Absolute path to the logs directory (used by revealLogs + the e2e assertion). */
  logsDir(): string {
    return this.dir;
  }

  /** Live level update when the user changes it in Settings — no restart. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** True when logging is disabled (`off`); callers surface a friendly note instead of a tail. */
  isOff(): boolean {
    return this.level === 'off';
  }

  /**
   * Last `n` lines of the ACTIVE log file (Slice B — the Settings→About tail). Bounded by
   * `TAIL_MAX_LINES`/`TAIL_MAX_BYTES`. Disk content is already redacted (the sink redacts
   * before writing). Best-effort: a missing/unreadable file yields '' (never throws).
   */
  readTail(n: number): string {
    const cap = Math.min(Math.max(0, n), TAIL_MAX_LINES);
    if (cap === 0) return '';
    try {
      const stat = fs.statSync(this.file);
      const start = Math.max(0, stat.size - TAIL_MAX_BYTES);
      const fd = fs.openSync(this.file, 'r');
      try {
        const len = stat.size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return tailLines(buf.toString('utf8'), cap);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /**
   * Assemble a diagnostics bundle (Slice B): a version/OS header (NOT a process.env dump) +
   * the tail of the active log (already redacted on disk). Writes a single
   * `conduit-diagnostics-<ts>.txt` into the logs dir and returns its absolute path so the
   * caller can reveal it. Best-effort: returns null on any failure (never throws).
   */
  buildDiagnostics(info: Omit<DiagnosticsInfo, 'ts'>): string | null {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const header = buildDiagnosticsHeader({ ...info, ts: Date.now() });
      const body = this.isOff()
        ? '(logging is off — no recent log content)'
        : this.readTail(TAIL_MAX_LINES);
      const out = path.join(this.dir, `conduit-diagnostics-${Date.now()}.txt`);
      fs.writeFileSync(out, `${header}${body}\n`);
      return out;
    } catch {
      return null;
    }
  }

  error(scope: Scope, msg: string, data?: Record<string, unknown>): void {
    this.emit('error', scope, msg, data);
  }
  warn(scope: Scope, msg: string, data?: Record<string, unknown>): void {
    this.emit('warn', scope, msg, data);
  }
  info(scope: Scope, msg: string, data?: Record<string, unknown>): void {
    this.emit('info', scope, msg, data);
  }
  debug(scope: Scope, msg: string, data?: Record<string, unknown>): void {
    this.emit('debug', scope, msg, data);
  }
  trace(scope: Scope, msg: string, data?: Record<string, unknown>): void {
    this.emit('trace', scope, msg, data);
  }

  private emit(level: Level, scope: Scope, msg: string, data?: Record<string, unknown>): void {
    if (!levelEnabled(this.level, level)) return;
    const record: LogRecord = { ts: Date.now(), level, scope, msg };
    const masked = redact(data);
    if (masked) record.data = masked;
    const line = formatRecord(record);
    this.write(line);
    if (!app.isPackaged) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[${scope}] ${msg}`, masked ?? '');
    }
  }

  private activeFileName(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    return `conduit-${stamp}.log`;
  }

  private initSink(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch {
      // userData unwritable / disk issue — degrade to console-only.
      this.writeDegraded = true;
    }
  }

  private write(line: string): void {
    if (this.writeDegraded) return;
    const payload = `${line}\n`;
    try {
      if (shouldRotate(this.bytes, ROTATE_CAP_BYTES)) this.rotate();
      fs.appendFileSync(this.file, payload);
      this.bytes += Buffer.byteLength(payload);
    } catch {
      // Best-effort: a write failure must never throw into the caller. Drop to console
      // and stop trying to write this run (lazy: the next constructor re-attempts the sink).
      this.writeDegraded = true;
      if (!app.isPackaged) console.error('[logger] sink write failed; degrading to console-only');
    }
  }

  // Roll the active file to a suffixed sibling and prune to KEEP_FILES. Synchronous within
  // the write path so two appends can't both roll. A failure here is swallowed by write().
  private rotate(): void {
    const stamp = `${Date.now()}`;
    const rolled = this.file.replace(/\.log$/, `-${stamp}.log`);
    try {
      fs.renameSync(this.file, rolled);
    } catch {
      /* the active file may already be gone — proceed to a fresh one */
    }
    this.bytes = 0;
    try {
      const logs = fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith('conduit-') && f.endsWith('.log'));
      for (const f of pruneOldLogs(logs, KEEP_FILES)) {
        fs.unlinkSync(path.join(this.dir, f));
      }
    } catch {
      /* prune is best-effort */
    }
  }
}
