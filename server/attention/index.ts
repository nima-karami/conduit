import type { AttentionEdge, AttentionPort } from '../../src/contracts/server-ports';
import type {
  ReportedStatus,
  RuntimeEvent,
  TerminalRuntime,
} from '../../src/contracts/terminal-runtime';
import { type BellScanState, countBareBells } from '../../src/last-line';
import { type ActivitySnapshot, SessionActivity } from '../../src/session-activity';
import { scanInertOutput } from '../../src/terminal-output';

/** Today's sweep cadence: at most half the busy window, so idle detection lags ≤ 750 ms. */
const ATTENTION_SWEEP_MS = 750;

interface Reported {
  status: Exclude<ReportedStatus, null>;
  needsAttention: boolean;
  /** Episode latch, as SessionActivity's: one edge until acknowledged. */
  armed: boolean;
  completedRun: boolean;
}

export interface ServerAttentionDeps {
  runtime: Pick<TerminalRuntime, 'on'>;
  now?: () => number;
  sweepMs?: number;
}

/**
 * All of attention (C7 AttentionPort). A program's OSC 7501 report drives it wherever it reports;
 * the output heuristics (bells, the inert scan) apply only to programs that don't (D34).
 */
export class ServerAttention implements AttentionPort {
  private readonly activity = new SessionActivity();
  private readonly reported = new Map<string, Reported>();
  private readonly bells = new Map<string, BellScanState>();
  private readonly inertTails = new Map<string, string>();
  /** Window ids presence reported, so clearAll can drop every one of them. */
  private readonly windows = new Set<number>();
  private readonly edgeListeners = new Set<(edge: AttentionEdge) => void>();
  private readonly changeListeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly off: () => void;

  constructor(deps: ServerAttentionDeps) {
    this.now = deps.now ?? Date.now;
    this.off = deps.runtime.on((e) => this.record(e));
    this.timer = setInterval(() => this.sweep(), deps.sweepMs ?? ATTENTION_SWEEP_MS);
    this.timer.unref();
  }

  statusOf(sessionId: string): ActivitySnapshot {
    const base = this.activity.statusOf(sessionId);
    const r = this.reported.get(sessionId);
    if (!r) return base;
    return {
      busy: r.status.state === 'working',
      needsAttention: r.needsAttention,
      completedRun: base.completedRun || r.completedRun,
    };
  }

  lastOutputAt(sessionId: string): number | undefined {
    return this.activity.lastOutputAt(sessionId);
  }

  setVisible(windowId: number, ids: readonly string[]): boolean {
    this.windows.add(windowId);
    let changed = this.activity.setVisible(windowId, ids);
    for (const id of ids) if (this.acknowledgeReported(id)) changed = true;
    if (changed) this.changed();
    return changed;
  }

  dropWindow(windowId: number): void {
    this.windows.delete(windowId);
    this.activity.dropWindow(windowId);
  }

  /**
   * Typing is not an acknowledgment, only seeing a session is (v0.51): input sent into a hidden
   * session keeps its badge. See docs/specs/archive/2026-08-21-attention-signal-quality.md.
   */
  recordInput(_sessionId: string, _now: number): void {}

  clearAll(): void {
    for (const windowId of [...this.windows]) this.dropWindow(windowId);
  }

  onEdge(listener: (edge: AttentionEdge) => void): () => void {
    this.edgeListeners.add(listener);
    return () => this.edgeListeners.delete(listener);
  }

  /** statusOf changed: compose re-sends `sessions.changed`, as today's scheduleActivityBroadcast. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.off();
  }

  forgetSession(sessionId: string): void {
    this.reset(sessionId);
    this.activity.forget(sessionId);
  }

  sweep(): void {
    const { changed, edges } = this.activity.sweep(this.now());
    for (const edge of edges)
      if (!this.reported.has(edge.id)) this.edge({ sessionId: edge.id, kind: edge.kind });
    if (changed) this.changed();
  }

  private record(e: RuntimeEvent): void {
    if (e.type === 'spawned') {
      this.reset(e.sessionId);
      this.activity.recordSpawn(e.sessionId, this.now());
      this.changed();
    } else if (e.type === 'exit') {
      this.reset(e.sessionId);
      this.activity.recordExit(e.sessionId);
      this.changed();
    } else if (e.type === 'data') this.output(e.sessionId, e.data);
    else if (e.type === 'status') this.status(e.sessionId, e.status);
  }

  private output(sessionId: string, data: string): void {
    // The busy clock still runs for a reporting program: the notice gate reads lastOutputAt; its
    // heuristic edges are dropped in sweep and its flags come from the report.
    const scan = countBareBells(data, this.bells.get(sessionId));
    this.bells.set(sessionId, scan.state);
    const inert = scanInertOutput(this.inertTails.get(sessionId) ?? '', data);
    this.inertTails.set(sessionId, inert.tail);
    if (inert.inert) return;
    if (this.activity.recordOutput(sessionId, this.now(), data.length, scan.bells)) this.changed();
  }

  private status(sessionId: string, status: ReportedStatus): void {
    const before = this.statusOf(sessionId);
    this.applyStatus(sessionId, status);
    const after = this.statusOf(sessionId);
    if (before.busy !== after.busy || before.needsAttention !== after.needsAttention)
      this.changed();
  }

  private applyStatus(sessionId: string, status: ReportedStatus): void {
    if (!status) {
      this.reported.delete(sessionId);
      return;
    }
    const prev = this.reported.get(sessionId);
    const r: Reported = prev ?? {
      status,
      needsAttention: false,
      armed: false,
      completedRun: false,
    };
    const wasWorking = prev?.status.state === 'working';
    r.status = status;
    this.reported.set(sessionId, r);
    if (status.state === 'working') {
      r.needsAttention = false;
      r.armed = false;
    } else {
      if (wasWorking) r.completedRun = true;
      // Only an entry into waiting arms: a repeated `blocked` report is the same episode.
      const waiting =
        wasWorking || (status.state === 'blocked' && prev?.status.state !== 'blocked');
      if (waiting && !r.armed && !this.activity.isVisible(sessionId)) {
        r.needsAttention = true;
        r.armed = true;
        this.edge({ sessionId, kind: 'run-end' });
      }
    }
  }

  private acknowledgeReported(sessionId: string): boolean {
    const r = this.reported.get(sessionId);
    if (!r) return false;
    r.armed = false;
    if (!r.needsAttention) return false;
    r.needsAttention = false;
    return true;
  }

  private reset(sessionId: string): void {
    this.reported.delete(sessionId);
    this.bells.delete(sessionId);
    this.inertTails.delete(sessionId);
  }

  private edge(edge: AttentionEdge): void {
    for (const listener of this.edgeListeners) listener(edge);
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }
}
