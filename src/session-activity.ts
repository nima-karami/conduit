import type { Session } from './types';

/**
 * Pure, runtime-only activity tracker for sessions, driven by PTY output.
 *
 * Three derived flags per session, layered on top of the lifecycle `status`:
 * - `busy`: produced output within the rolling busy window.
 * - `needsAttention`: transitioned busy -> idle (a task finished) while it was
 *   NOT the focused session. Cleared on focus, on new output, or on forget.
 * - `completedRun`: has finished at least one busy -> idle cycle. Unlike the other two
 *   it is a latch, not a state: it answers "did something actually run here?", which is
 *   half of the Review-state test (D15). Cleared only by forget().
 *
 * Time is injected (callers pass `now`) so the machine is deterministic and
 * fully unit-testable without timers. The host owns the wall clock + sweep loop.
 */
export interface ActivityOptions {
  busyWindowMs?: number;
}

interface Entry {
  lastOutputAt: number;
  busy: boolean;
  needsAttention: boolean;
  completedRun: boolean;
}

const NONE = { busy: false, needsAttention: false, completedRun: false } as const;

export class SessionActivity {
  private readonly entries = new Map<string, Entry>();
  private focusedId: string | undefined;
  private readonly busyWindowMs: number;

  constructor(opts: ActivityOptions = {}) {
    this.busyWindowMs = opts.busyWindowMs ?? 1500;
  }

  /** Record PTY output for a session. Returns true if public flags changed. */
  recordOutput(id: string, now: number): boolean {
    const e = this.entries.get(id);
    if (!e) {
      this.entries.set(id, {
        lastOutputAt: now,
        busy: true,
        needsAttention: false,
        completedRun: false,
      });
      return true; // untracked/idle -> busy
    }
    e.lastOutputAt = now;
    const wasBusy = e.busy;
    const hadAttention = e.needsAttention;
    e.busy = true;
    e.needsAttention = false; // output means it's working again, not waiting
    return !wasBusy || hadAttention;
  }

  /**
   * Detect busy -> idle transitions at `now`. A session whose last output is
   * older than the busy window goes idle; if it was not the focused session at
   * that moment, it gains needsAttention. Returns true if anything changed.
   */
  sweep(now: number): boolean {
    let changed = false;
    for (const [id, e] of this.entries) {
      if (e.busy && now - e.lastOutputAt >= this.busyWindowMs) {
        e.busy = false;
        e.completedRun = true;
        if (id !== this.focusedId) e.needsAttention = true;
        changed = true;
      }
    }
    return changed;
  }

  /** Set the focused session; clears its needsAttention. Returns true if changed. */
  focus(id: string | undefined): boolean {
    this.focusedId = id;
    if (id === undefined) return false;
    const e = this.entries.get(id);
    if (e?.needsAttention) {
      e.needsAttention = false;
      return true;
    }
    return false;
  }

  /** Stop tracking a removed session. */
  forget(id: string): void {
    this.entries.delete(id);
  }

  /** Current public flags for a session (defaults to all-false when untracked). */
  statusOf(id: string): { busy: boolean; needsAttention: boolean; completedRun: boolean } {
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
}
