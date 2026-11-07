import type { StuckScreen } from '../../src/cli-stuck-screens';
import type {
  AttentionEdge,
  AttentionPort,
  ServerAttentionSnapshot,
} from '../../src/contracts/server-ports';
import type {
  ReportedStatus,
  RuntimeEvent,
  TerminalRuntime,
} from '../../src/contracts/terminal-runtime';
import { type BellScanState, countBareBells } from '../../src/last-line';
import { SessionActivity } from '../../src/session-activity';
import { scanInertOutput } from '../../src/terminal-output';
import type { AttentionReason } from '../../src/types';

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
  /**
   * The sidebar's facts (docs/specs/archive/2026-11-02-sidebar-agent-tree.md §4). Completions outlive
   * spawn/exit resets on purpose, so a relaunch never resurrects an unseen run as new.
   */
  private readonly completions = new Map<string, number>();
  private readonly reasons = new Map<string, Exclude<AttentionReason, null>>();
  /** Kept apart from `reasons`: visibility acknowledges those, but not a screen still stuck. */
  private readonly stuck = new Map<string, StuckScreen>();
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

  statusOf(sessionId: string): ServerAttentionSnapshot {
    const stuck = this.stuck.get(sessionId);
    const facts = {
      attentionReason: stuck ? ('stuck' as const) : (this.reasons.get(sessionId) ?? null),
      ...(stuck ? { stuckReason: stuck.reason } : {}),
      completions: this.completions.get(sessionId) ?? 0,
    };
    const base = this.activity.statusOf(sessionId);
    const r = this.reported.get(sessionId);
    if (!r) return { ...base, ...facts };
    return {
      busy: r.status.state === 'working',
      needsAttention: r.needsAttention,
      completedRun: base.completedRun || r.completedRun,
      ...facts,
    };
  }

  lastOutputAt(sessionId: string): number | undefined {
    return this.activity.lastOutputAt(sessionId);
  }

  setStuck(sessionId: string, stuck: StuckScreen | null): void {
    const prev = this.stuck.get(sessionId);
    if (stuck === null) {
      if (!prev) return;
      this.stuck.delete(sessionId);
    } else {
      if (prev?.kind === stuck.kind && prev.reason === stuck.reason) return;
      this.stuck.set(sessionId, stuck);
    }
    this.changed();
  }

  setVisible(windowId: number, ids: readonly string[]): boolean {
    this.windows.add(windowId);
    let changed = this.activity.setVisible(windowId, ids);
    for (const id of ids) {
      if (this.acknowledgeReported(id)) changed = true;
      if (this.reasons.delete(id)) changed = true;
    }
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
    this.completions.delete(sessionId);
    this.activity.forget(sessionId);
  }

  sweep(): void {
    const swept = this.activity.sweep(this.now());
    let changed = swept.changed;
    for (const edge of swept.edges)
      if (!this.reported.has(edge.id)) this.edge({ sessionId: edge.id, kind: edge.kind });
    // A reporting program's report is authoritative, so its output never counts twice.
    for (const id of swept.completedIds)
      if (!this.reported.has(id)) {
        this.complete(id);
        changed = true;
      }
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
    const becameBusy = this.activity.recordOutput(sessionId, this.now(), data.length, scan.bells);
    // The bell reason has no episode latch, unlike the legacy edge: every unseen bell raises it,
    // and the next run of output (Working again) puts it down. Heuristics only (D34).
    let reasonChanged = false;
    if (!this.reported.has(sessionId)) {
      if (scan.bells > 0 && !this.activity.isVisible(sessionId)) {
        reasonChanged = this.reasons.get(sessionId) !== 'bell';
        this.reasons.set(sessionId, 'bell');
      } else if (becameBusy && this.reasons.get(sessionId) === 'bell') {
        this.reasons.delete(sessionId);
        reasonChanged = true;
      }
    }
    if (becameBusy || reasonChanged) this.changed();
  }

  private status(sessionId: string, status: ReportedStatus): void {
    const before = this.statusOf(sessionId);
    this.applyStatus(sessionId, status);
    const after = this.statusOf(sessionId);
    if (
      before.busy !== after.busy ||
      before.needsAttention !== after.needsAttention ||
      before.attentionReason !== after.attentionReason ||
      before.completions !== after.completions
    )
      this.changed();
  }

  private applyStatus(sessionId: string, status: ReportedStatus): void {
    const prev = this.reported.get(sessionId);
    // Evidence gathered under the other authority must not complete a run under this one, or a
    // program that stops reporting right after a reported Done would count that run twice.
    if ((prev === undefined) !== (status === null))
      this.activity.resetCompletionEvidence(sessionId);
    if (!status) {
      this.reported.delete(sessionId);
      this.reasons.delete(sessionId);
      return;
    }
    const r: Reported = prev ?? {
      status,
      needsAttention: false,
      armed: false,
      completedRun: false,
    };
    const wasWorking = prev?.status.state === 'working';
    const wasBlocked = prev?.status.state === 'blocked';
    r.status = status;
    this.reported.set(sessionId, r);
    if (status.state !== 'blocked') this.reasons.delete(sessionId);
    else if (!wasBlocked && !this.activity.isVisible(sessionId))
      this.reasons.set(sessionId, 'blocked');
    if (wasWorking && (status.state === 'done' || status.state === 'idle'))
      this.complete(sessionId);
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

  private complete(sessionId: string): void {
    this.completions.set(sessionId, (this.completions.get(sessionId) ?? 0) + 1);
  }

  private reset(sessionId: string): void {
    this.reported.delete(sessionId);
    this.reasons.delete(sessionId);
    this.stuck.delete(sessionId);
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
