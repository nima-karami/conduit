import type { Session } from './types';

/**
 * Pure, runtime-only activity tracker for sessions, driven by PTY output.
 *
 * Three derived flags per session, layered on top of the lifecycle `status`:
 * - `busy`: produced output within the rolling busy window.
 * - `needsAttention`: the session has evidence it is waiting for the user and nobody
 *   has looked at it since. See docs/specs/2026-08-21-attention-signal-quality.md for
 *   the contract — the short version is that "output stopped" alone is not evidence.
 * - `completedRun`: has finished at least one busy -> idle cycle. Unlike the other two
 *   it is a latch, not a state: it answers "did something actually run here?", which is
 *   half of the Review-state test (D15). Cleared only by forget().
 *
 * Time is injected (callers pass `now`) so the machine is deterministic and
 * fully unit-testable without timers. The host owns the wall clock + sweep loop.
 */

/** A run must last this long to be evidence that something happened. */
export const MIN_RUN_MS = 2000;
/** ...or produce this many bytes, for the fast-but-substantial burst. */
export const MIN_RUN_BYTES = 1024;
/**
 * Quiet gap before a qualifying run arms attention. Deliberately longer than the busy
 * window: the Busy meter wants to drop promptly, "needs you" wants to be sure.
 */
export const ATTENTION_QUIET_MS = 4000;
/** Output this soon after a spawn is startup noise (banners, relaunch markers), not work. */
export const SPAWN_GRACE_MS = 5000;

export interface ActivityOptions {
  busyWindowMs?: number;
  minRunMs?: number;
  minRunBytes?: number;
  attentionQuietMs?: number;
  spawnGraceMs?: number;
}

export interface ActivitySnapshot {
  busy: boolean;
  needsAttention: boolean;
  completedRun: boolean;
}

/** A session that just entered an attention episode, and what armed it. */
export interface AttentionEdge {
  id: string;
  kind: 'run-end' | 'bell';
}

/**
 * `changed` covers the public flags (busy/needsAttention/completedRun) so the host can
 * coalesce its broadcast; `edges` are the one-shot arming events the OS surfaces
 * (taskbar flash, notification) fire on.
 */
export interface SweepResult {
  changed: boolean;
  edges: AttentionEdge[];
}

interface Entry {
  lastOutputAt: number;
  busy: boolean;
  needsAttention: boolean;
  completedRun: boolean;
  /** Start of the run in flight; undefined once the run has been consumed or reset. */
  runStartAt: number | undefined;
  runBytes: number;
  pendingBell: boolean;
  /** Episode latch: an armed session cannot arm again until it is acknowledged. */
  armed: boolean;
  spawnAt: number | undefined;
  exited: boolean;
}

const NONE: ActivitySnapshot = { busy: false, needsAttention: false, completedRun: false };

const newEntry = (at: number): Entry => ({
  lastOutputAt: at,
  busy: false,
  needsAttention: false,
  completedRun: false,
  runStartAt: undefined,
  runBytes: 0,
  pendingBell: false,
  armed: false,
  spawnAt: undefined,
  exited: false,
});

/** Drop the evidence a session has accumulated. Public flags are untouched. */
function clearRun(e: Entry): void {
  e.runStartAt = undefined;
  e.runBytes = 0;
  e.pendingBell = false;
}

export class SessionActivity {
  private readonly entries = new Map<string, Entry>();
  /** Sessions on screen right now, keyed by the window that reports them (contract 4). */
  private readonly visibleByWindow = new Map<number, ReadonlySet<string>>();
  private readonly busyWindowMs: number;
  private readonly minRunMs: number;
  private readonly minRunBytes: number;
  private readonly attentionQuietMs: number;
  private readonly spawnGraceMs: number;

  constructor(opts: ActivityOptions = {}) {
    this.busyWindowMs = opts.busyWindowMs ?? 1500;
    this.minRunMs = opts.minRunMs ?? MIN_RUN_MS;
    this.minRunBytes = opts.minRunBytes ?? MIN_RUN_BYTES;
    this.attentionQuietMs = opts.attentionQuietMs ?? ATTENTION_QUIET_MS;
    this.spawnGraceMs = opts.spawnGraceMs ?? SPAWN_GRACE_MS;
  }

  /**
   * Record PTY output for a session: `bytes` in the chunk and how many of its BELs were
   * real bells (src/last-line.ts `countBareBells`). Returns true if public flags changed.
   */
  recordOutput(id: string, now: number, bytes: number, bareBells: number): boolean {
    let e = this.entries.get(id);
    if (!e) {
      e = newEntry(now);
      this.entries.set(id, e);
    }
    e.lastOutputAt = now;
    const wasBusy = e.busy;
    e.busy = true;

    // Startup noise, and a session the user is already watching, are not evidence — so
    // neither accumulates a run (contracts 4 and 5).
    if (this.inSpawnGrace(e, now) || this.isVisible(id)) {
      clearRun(e);
      return !wasBusy;
    }
    if (e.runStartAt === undefined) {
      e.runStartAt = now;
      e.runBytes = 0;
    }
    e.runBytes += bytes;
    if (bareBells > 0) e.pendingBell = true;
    return !wasBusy;
  }

  /** A PTY was (re)spawned for this session: start its grace window and wipe its episode. */
  recordSpawn(id: string, now: number): void {
    const e = this.entries.get(id) ?? newEntry(now);
    clearRun(e);
    e.needsAttention = false;
    e.armed = false;
    e.exited = false;
    e.spawnAt = now;
    this.entries.set(id, e);
  }

  /** The child exited: nothing here is waiting for the user any more (contract 6). */
  recordExit(id: string): void {
    const e = this.entries.get(id) ?? newEntry(0);
    clearRun(e);
    e.needsAttention = false;
    e.armed = false;
    e.exited = true;
    this.entries.set(id, e);
  }

  /**
   * Report the sessions one window currently shows (its active session plus any split).
   * Seeing a session acknowledges it. Returns true if public flags changed.
   */
  setVisible(windowId: number, ids: readonly string[]): boolean {
    this.visibleByWindow.set(windowId, new Set(ids));
    let changed = false;
    for (const id of ids) if (this.acknowledge(id)) changed = true;
    return changed;
  }

  /** A window closed: its sessions are no longer on anyone's screen. */
  dropWindow(windowId: number): void {
    this.visibleByWindow.delete(windowId);
  }

  /** Stop tracking a removed session. */
  forget(id: string): void {
    this.entries.delete(id);
  }

  /**
   * Detect busy -> idle transitions and arm attention where the evidence justifies it.
   * Arming is one-shot per episode; the returned edges are what the OS surfaces fire on.
   */
  sweep(now: number): SweepResult {
    let changed = false;
    const edges: AttentionEdge[] = [];
    for (const [id, e] of this.entries) {
      if (e.busy && now - e.lastOutputAt >= this.busyWindowMs) {
        e.busy = false;
        e.completedRun = true;
        changed = true;
      }
      // A watched session is continuously acknowledged, so a run that finishes while the
      // user is looking can never arm later, once they switch away.
      if (this.isVisible(id)) {
        if (this.acknowledge(id)) changed = true;
        continue;
      }
      if (e.armed || e.exited || this.inSpawnGrace(e, now)) continue;
      const kind = this.armingEvidence(e, now);
      if (!kind) continue;
      e.needsAttention = true;
      e.armed = true;
      clearRun(e);
      edges.push({ id, kind });
      changed = true;
    }
    return { changed, edges };
  }

  /** Current public flags for a session (defaults to all-false when untracked). */
  statusOf(id: string): ActivitySnapshot {
    const e = this.entries.get(id);
    if (!e) return { ...NONE };
    return { busy: e.busy, needsAttention: e.needsAttention, completedRun: e.completedRun };
  }

  /**
   * Merge the derived flags onto each session (untracked -> false). `decorate` adds the
   * fields the tracker does not own but that ride the same broadcast — today the PTY
   * tail's `lastLine` — so the host has one merge point rather than two passes.
   */
  apply(sessions: Session[], decorate?: (id: string) => Partial<Session>): Session[] {
    return sessions.map((s) => ({ ...s, ...this.statusOf(s.id), ...decorate?.(s.id) }));
  }

  /** Which evidence, if any, arms this session right now. */
  private armingEvidence(e: Entry, now: number): AttentionEdge['kind'] | null {
    if (e.pendingBell) return 'bell';
    if (e.runStartAt === undefined) return null;
    const qualified =
      e.lastOutputAt - e.runStartAt >= this.minRunMs || e.runBytes >= this.minRunBytes;
    if (!qualified) return null;
    return now - e.lastOutputAt >= this.attentionQuietMs ? 'run-end' : null;
  }

  /** The user has seen this session: end the episode and start counting evidence over. */
  private acknowledge(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    clearRun(e);
    e.armed = false;
    if (!e.needsAttention) return false;
    e.needsAttention = false;
    return true;
  }

  private inSpawnGrace(e: Entry, now: number): boolean {
    return e.spawnAt !== undefined && now - e.spawnAt < this.spawnGraceMs;
  }

  private isVisible(id: string): boolean {
    for (const ids of this.visibleByWindow.values()) if (ids.has(id)) return true;
    return false;
  }
}
