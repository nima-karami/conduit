import type { ScreenSnapshot } from '../../src/conduit-mcp/screen-verdict';
import type { ScreenPort } from '../../src/contracts/server-ports';
import { SCREEN_BACKLOG_MAX_BYTES } from '../../src/contracts/terminal-runtime';
import type { TermGeometry } from '../../src/protocol';
import { createSessionScreens } from './session-screens';

export interface ServerScreensDeps {
  sizeOf(sessionId: string): TermGeometry | undefined;
  /** The model was discarded past the backlog bound: re-take the active attach to reseed it (F8). */
  reseed(sessionId: string): void;
  maxBacklog?: number;
}

/** hc's default spawn size, for a model started before any size is known. */
const DEFAULT_SIZE: TermGeometry = { cols: 200, rows: 120 };

/**
 * The notice gate's screen models, fed off the credit path: output is queued here and handed to
 * the parser on the next turn, so a slow parse never holds back the ring append that grants hc
 * credit (D18, D20).
 */
export class ServerScreens implements ScreenPort {
  private readonly models = createSessionScreens();
  private readonly queued = new Map<string, string>();
  /** Discarded past the backlog bound; reads as unknown until the next paint reseeds it. */
  private readonly unknown = new Set<string>();
  private flushScheduled = false;
  private readonly maxBacklog: number;

  constructor(private readonly deps: ServerScreensDeps) {
    this.maxBacklog = deps.maxBacklog ?? SCREEN_BACKLOG_MAX_BYTES;
  }

  ensure(sessionId: string, opts: { seedTail: boolean }): void {
    if (this.models.has(sessionId) || this.unknown.has(sessionId)) return;
    this.flush(sessionId);
    if (!opts.seedTail) this.models.dispose(sessionId);
    const size = this.size(sessionId);
    this.models.start(sessionId, size.cols, size.rows);
  }

  keepTail(sessionId: string): void {
    this.queued.delete(sessionId);
    this.unknown.delete(sessionId);
    const size = this.size(sessionId);
    this.models.keepTail(sessionId, size.cols, size.rows);
  }

  release(sessionId: string): void {
    this.queued.delete(sessionId);
    this.unknown.delete(sessionId);
    this.models.dispose(sessionId);
  }

  feed(sessionId: string, data: string): void {
    if (this.unknown.has(sessionId)) return;
    this.queued.set(sessionId, (this.queued.get(sessionId) ?? '') + data);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      for (const id of [...this.queued.keys()]) this.flush(id);
    });
  }

  /** A full repaint from hc: a running or discarded model restarts from it at the paint's size. */
  paint(sessionId: string, data: string, size: TermGeometry): void {
    this.flush(sessionId);
    if (this.models.has(sessionId) || this.unknown.delete(sessionId)) {
      this.models.dispose(sessionId);
      this.models.start(sessionId, size.cols, size.rows);
    }
    this.feed(sessionId, data);
  }

  resize(sessionId: string, size: TermGeometry): void {
    this.flush(sessionId);
    this.models.resize(sessionId, size.cols, size.rows);
  }

  /** Resolves after every byte fed before the call is parsed; null while none runs or unknown. */
  async snapshot(sessionId: string): Promise<ScreenSnapshot | null> {
    this.flush(sessionId);
    if (this.unknown.has(sessionId)) return null;
    return (await this.models.snapshot(sessionId)) ?? null;
  }

  private flush(sessionId: string): void {
    const data = this.queued.get(sessionId);
    if (data === undefined) return;
    this.queued.delete(sessionId);
    this.models.feed(sessionId, data);
    if (this.models.backlog(sessionId) <= this.maxBacklog) return;
    this.models.dispose(sessionId);
    this.unknown.add(sessionId);
    this.deps.reseed(sessionId);
  }

  private size(sessionId: string): TermGeometry {
    return this.deps.sizeOf(sessionId) ?? DEFAULT_SIZE;
  }
}
