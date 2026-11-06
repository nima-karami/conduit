import type { ReplayRun, TermGeometry } from './protocol';
import {
  attachReplay,
  type ColdReplay,
  coldReplay,
  lastRelaunchAt,
  RingBuffer,
  ringPrefix,
  SCROLLBACK_CAP_BYTES,
  type ScrollbackRing,
  serializeScrollback,
} from './scrollback-persistence';

const PERSIST_DEBOUNCE_MS = 250;

export interface ScrollbackStoreOptions {
  /** Delivers a host-composed line to the session's terminal. */
  send: (sessionId: string, data: string) => void;
  /** Whether the session's stream is being recorded (scrollback persistence is on). */
  recording: () => boolean;
  cap?: number;
}

/**
 * Every session's scrollback ring (T2) and its debounced write to disk. A segment's geometry is
 * stamped when its bytes arrive, so a flush never has to ask a PTY that may already be gone.
 */
export class ScrollbackStore {
  private readonly rings = new Map<string, RingBuffer>();
  /** What the last write to disk held, so an idle ring isn't re-serialised every flush. */
  private readonly written = new Map<string, { version: number; beforeLaunch?: number }>();
  /** Characters of each ring recorded before the session's current launch; trimmed with it. */
  private readonly beforeLaunch = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly send: (sessionId: string, data: string) => void;
  private readonly recording: () => boolean;
  private readonly cap: number;

  constructor(
    private readonly persist: (sessionId: string, blob: string) => void,
    options: ScrollbackStoreOptions,
  ) {
    this.send = options.send;
    this.recording = options.recording;
    this.cap = options.cap ?? SCROLLBACK_CAP_BYTES;
  }

  append(sessionId: string, chunk: string, geometry: TermGeometry | undefined): void {
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = new RingBuffer();
      this.rings.set(sessionId, ring);
    }
    const had = ring.charCount;
    ring.append(chunk, geometry, this.cap);
    const before = this.beforeLaunch.get(sessionId);
    if (before !== undefined) {
      const trimmed = had + chunk.length - ring.charCount;
      this.beforeLaunch.set(sessionId, Math.max(0, before - trimmed));
    }
    if (this.timers.has(sessionId)) return;
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        this.flush(sessionId);
      }, PERSIST_DEBOUNCE_MS),
    );
  }

  /**
   * The replay for a fresh pane over a new child: this app run's ring when it has one, else the
   * one `restore` reads from disk (kept segment by segment, so the new child's output doesn't
   * relabel it). The replay's tail is recorded too: the terminal is shown it.
   */
  replayForColdStart(
    sessionId: string,
    restore: () => ScrollbackRing | undefined,
  ): ColdReplay | undefined {
    let buffer = this.rings.get(sessionId);
    if (!buffer) {
      const restored = restore();
      if (!restored) return undefined;
      buffer = RingBuffer.from(restored);
      this.rings.set(sessionId, buffer);
    }
    const replay = coldReplay(buffer.toRing());
    if (replay.tail) this.append(sessionId, replay.tail.data, replay.tail.geometry);
    return replay;
  }

  /** `replayForColdStart` for a pane over no child: nothing follows the replay, so nothing is recorded. */
  replayForView(sessionId: string): ColdReplay | undefined {
    const ring = this.rings.get(sessionId);
    return ring ? coldReplay(ring.toRing()) : undefined;
  }

  /**
   * A host-composed line in the session's stream. The ring must hold exactly what the terminal
   * was shown, or a later replay drifts from it: a spawn clear replayed without the padding that
   * preceded it erased the run before.
   */
  show(sessionId: string, data: string, geometry: TermGeometry): void {
    this.send(sessionId, data);
    if (this.recording()) this.append(sessionId, data, geometry);
  }

  /** A new launch starts here: what the ring holds now is the launches before it. */
  markLaunch(sessionId: string, at = this.heldChars(sessionId)): void {
    this.beforeLaunch.set(sessionId, at);
  }
  private heldChars(sessionId: string): number {
    const ring = this.rings.get(sessionId);
    return ring ? ring.charCount : 0;
  }

  /**
   * The ring before the current launch, for a pane attaching to it live: its own output comes from
   * the core's history instead. With no recorded mark (a file written without one), everything
   * before the last relaunch marker, so nothing of the live launch is shown twice.
   */
  replayBeforeLaunch(sessionId: string): { data: string; runs: ReplayRun[] } | undefined {
    const ring = this.rings.get(sessionId)?.toRing() ?? [];
    const before = this.beforeLaunch.get(sessionId) ?? lastRelaunchAt(ring) ?? 0;
    const replay = attachReplay(ringPrefix(ring, before));
    return replay.data ? replay : undefined;
  }

  /** The replay for a pane attaching to the session's live child (see `attachReplay`). */
  attachReplay(sessionId: string): { data: string; runs: ReplayRun[] } {
    return attachReplay(this.rings.get(sessionId)?.toRing() ?? []);
  }

  /** Writes now; a pending debounced write is cancelled, so it can't land after this one. */
  flush(sessionId: string): void {
    this.cancelTimer(sessionId);
    const ring = this.rings.get(sessionId);
    if (!ring) return;
    const beforeLaunch = this.beforeLaunch.get(sessionId);
    const last = this.written.get(sessionId);
    if (last && last.version === ring.version && last.beforeLaunch === beforeLaunch) return;
    this.written.set(sessionId, { version: ring.version, beforeLaunch });
    const segments = ring.toRing();
    this.persist(
      sessionId,
      serializeScrollback({
        version: 2,
        sessionId,
        segments,
        ...(beforeLaunch === undefined ? {} : { beforeLaunch }),
      }),
    );
  }

  flushPending(): void {
    for (const sessionId of [...this.timers.keys()]) this.flush(sessionId);
  }

  drop(sessionId: string): void {
    this.cancelTimer(sessionId);
    this.rings.delete(sessionId);
    this.written.delete(sessionId);
    this.beforeLaunch.delete(sessionId);
  }

  private cancelTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
