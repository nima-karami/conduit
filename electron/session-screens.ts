import { type IBufferLine, Terminal } from '@xterm/headless';
import { type ScreenSnapshot, STYLE_DIM, STYLE_PLAIN } from '../src/conduit-mcp/screen-verdict';

/** Spec §2.4 D6: a lazy model replays this much of the output it missed. */
export const SCREEN_TAIL_BYTES = 64 * 1024;

const rowText = (line: IBufferLine | undefined) => line?.translateToString(true).trimEnd() ?? '';

/** A style mask aligned char-for-char with rowText(line), which is `length` long. */
function styleMask(line: IBufferLine | undefined, length: number): string {
  let mask = '';
  const cell = line?.getCell(0);
  if (!line || !cell) return mask;
  for (let x = 0; x < line.length && mask.length < length; x += 1) {
    if (!line.getCell(x, cell)) break;
    // The trailing half of a wide char: translateToString skips it too.
    if (cell.getWidth() === 0) continue;
    const n = (cell.getChars() || ' ').length;
    mask += (cell.isDim() ? STYLE_DIM : STYLE_PLAIN).repeat(n);
  }
  return mask.slice(0, length);
}

/**
 * Host-side screen models for sessions with messaging: the gate needs the rendered screen, and
 * the PTY's raw tail can't rebuild a differentially repainted one (spec §2 "Screen model").
 * Headless only — never a renderer xterm or a WebGL addon (CLAUDE.md, Terminal).
 */
export interface SessionScreens {
  /** Starts the model; output kept by keepTail is replayed into it first, then dropped. */
  start(sessionId: string, cols: number, rows: number): void;
  /**
   * A new PTY generation of a session whose model starts later: drops any model and tail, then keeps
   * the last tailBytes of output until start (spec §2.4 D6).
   */
  keepTail(sessionId: string): void;
  feed(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  dispose(sessionId: string): void;
  snapshot(sessionId: string): Promise<ScreenSnapshot | undefined>;
  has(sessionId: string): boolean;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
// One encode buffer for every tail: a chunk is copied out of it before push returns, so the bound
// stays one preallocated ring per tail (review S4).
let scratch = new Uint8Array(0);

/** The last `cap` UTF-8 bytes of a stream, in one preallocated ring. */
class OutputTail {
  private readonly ring: Uint8Array;
  /** Bytes ever pushed; stream byte n sits at ring[n % cap] while n >= total - cap. */
  private total = 0;
  constructor(private readonly cap: number) {
    this.ring = new Uint8Array(cap);
  }
  push(data: string) {
    // Only the last cap bytes survive, and no UTF-16 unit encodes to less than one byte.
    const s = data.length > this.cap ? data.slice(-this.cap) : data;
    if (scratch.length < s.length * 3) scratch = new Uint8Array(s.length * 3);
    const n = utf8.encodeInto(s, scratch).written;
    const kept = scratch.subarray(Math.max(0, n - this.cap), n);
    const at = (this.total + n - kept.length) % this.cap;
    const first = Math.min(kept.length, this.cap - at);
    this.ring.set(kept.subarray(0, first), at);
    this.ring.set(kept.subarray(first), 0);
    this.total += n;
  }
  /** The kept bytes in stream order, as a copy. */
  private bytes() {
    const len = Math.min(this.total, this.cap);
    const at = (this.total - len) % this.cap;
    const out = new Uint8Array(len);
    const first = Math.min(len, this.cap - at);
    out.set(this.ring.subarray(at, at + first));
    out.set(this.ring.subarray(0, len - first), first);
    return out;
  }
  text() {
    return fromUtf8.decode(this.bytes());
  }
}

export function createSessionScreens(
  opts: { scrollback?: number; tailBytes?: number } = {},
): SessionScreens {
  const terms = new Map<string, Terminal>();
  const tails = new Map<string, OutputTail>();
  const tailBytes = opts.tailBytes ?? SCREEN_TAIL_BYTES;
  /** Snapshots waiting on a model's write callback, per model. */
  const waiting = new Map<Terminal, Set<(s: ScreenSnapshot | undefined) => void>>();
  const scrollback = opts.scrollback ?? 0;

  // A disposed model answers its waiters now: xterm may parse the dead backlog first, or never
  // call back, and the gate must not wait on a session that is gone.
  const dispose = (sessionId: string) => {
    tails.delete(sessionId);
    const term = terms.get(sessionId);
    if (!term) return;
    terms.delete(sessionId);
    const pending = waiting.get(term);
    waiting.delete(term);
    for (const resolve of pending ?? []) resolve(undefined);
    term.dispose();
  };

  return {
    start(sessionId, cols, rows) {
      const seed = tails.get(sessionId)?.text();
      dispose(sessionId);
      const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback });
      terms.set(sessionId, term);
      if (seed) term.write(seed);
    },
    keepTail(sessionId) {
      dispose(sessionId);
      tails.set(sessionId, new OutputTail(tailBytes));
    },
    feed(sessionId, data) {
      const term = terms.get(sessionId);
      if (term) term.write(data);
      else tails.get(sessionId)?.push(data);
    },
    resize(sessionId, cols, rows) {
      terms.get(sessionId)?.resize(cols, rows);
    },
    dispose,
    snapshot(sessionId) {
      const term = terms.get(sessionId);
      if (!term) return Promise.resolve(undefined);
      // An empty write's callback fires once every earlier write is parsed.
      return new Promise((resolve) => {
        let set = waiting.get(term);
        if (!set) {
          set = new Set();
          waiting.set(term, set);
        }
        set.add(resolve);
        term.write('', () => {
          if (!waiting.get(term)?.delete(resolve)) return;
          const buf = term.buffer.active;
          const lines: string[] = [];
          for (let y = 0; y < term.rows; y += 1)
            lines.push(rowText(buf.getLine(buf.viewportY + y)));
          const cursorY = buf.cursorY + buf.baseY - buf.viewportY;
          const cursorLine = buf.getLine(buf.viewportY + cursorY);
          resolve({
            lines,
            cursorY,
            cursorX: buf.cursorX,
            cursorRowStyles: styleMask(cursorLine, lines[cursorY]?.length ?? 0),
          });
        });
      });
    },
    has(sessionId) {
      return terms.has(sessionId);
    },
  };
}
