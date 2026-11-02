import { PAINT_MAX_MS, PAINT_QUIET_MS } from './contracts/terminal-runtime';

/**
 * Collects an attach's first paint by C1's boundary rule (D20): quiet for PAINT_QUIET_MS, capped
 * at PAINT_MAX_MS after the attach is held.
 */
export class PaintCollector {
  private chunks: string[] = [];
  private quiet?: ReturnType<typeof setTimeout>;
  private cap?: ReturnType<typeof setTimeout>;
  done = false;

  /** Armed when the attach is held: a viewer that is never painted still ends its paint. */
  constructor(private readonly onEnd: (data: string) => void) {
    this.cap = setTimeout(() => this.end(), PAINT_MAX_MS);
  }

  push(text: string): void {
    this.chunks.push(text);
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.end(), PAINT_QUIET_MS);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.quiet);
    clearTimeout(this.cap);
    this.onEnd(this.chunks.join(''));
  }
}
