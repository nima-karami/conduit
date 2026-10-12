import type { ReplayRun, TermGeometry } from './protocol';
import {
  appendToRing,
  attachReplay,
  type ColdReplay,
  coldReplay,
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
  private readonly rings = new Map<string, ScrollbackRing>();
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
    this.rings.set(
      sessionId,
      appendToRing(this.rings.get(sessionId) ?? [], chunk, geometry, this.cap),
    );
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
    const ring = this.rings.get(sessionId) ?? restore();
    if (!ring) return undefined;
    this.rings.set(sessionId, ring);
    const replay = coldReplay(ring);
    if (replay.tail) this.append(sessionId, replay.tail.data, replay.tail.geometry);
    return replay;
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

  /** The replay for a pane attaching to the session's live child (see `attachReplay`). */
  attachReplay(sessionId: string): { data: string; runs: ReplayRun[] } {
    return attachReplay(this.rings.get(sessionId) ?? []);
  }

  /** Writes now; a pending debounced write is cancelled, so it can't land after this one. */
  flush(sessionId: string): void {
    this.cancelTimer(sessionId);
    const segments = this.rings.get(sessionId);
    if (!segments) return;
    this.persist(sessionId, serializeScrollback({ version: 2, sessionId, segments }));
  }

  flushPending(): void {
    for (const sessionId of [...this.timers.keys()]) this.flush(sessionId);
  }

  drop(sessionId: string): void {
    this.cancelTimer(sessionId);
    this.rings.delete(sessionId);
  }

  private cancelTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
