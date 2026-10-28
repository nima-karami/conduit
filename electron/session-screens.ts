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
   * the last tailBytes of output, and the resizes between them, until start (spec §2.4 D6). Takes
   * the PTY's size at spawn.
   */
  keepTail(sessionId: string, cols: number, rows: number): void;
  feed(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  dispose(sessionId: string): void;
  snapshot(sessionId: string): Promise<ScreenSnapshot | undefined>;
  has(sessionId: string): boolean;
}

interface Size {
  cols: number;
  rows: number;
}

/** What a seeded model replays: it starts at `size`, then applies `steps` in order. */
interface TailReplay {
  size: Size;
  steps: Array<string | Size>;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
// One encode buffer for every tail: a chunk is copied out of it before push returns, so the bound
// stays one preallocated ring per tail (review S4).
let scratch = new Uint8Array(0);

/**
 * The last `cap` UTF-8 bytes of a stream, in one preallocated ring, with the PTY resizes between
 * them: bytes replay at the size they were written at (review S2).
 */
class OutputTail {
  private readonly ring: Uint8Array;
  /** Bytes ever pushed; stream byte n sits at ring[n % cap] while n >= total - cap. */
  private total = 0;
  /** Resizes after `head`'s, each before the stream byte at `at`. */
  private resizes: Array<Size & { at: number }> = [];
  constructor(
    private readonly cap: number,
    /** The size the oldest kept byte was written at. */
    private head: Size,
  ) {
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
    this.foldResizes(this.total - this.cap);
  }
  resize(cols: number, rows: number) {
    const last = this.resizes.at(-1);
    // Resizes with no output between them: only the last one matters.
    if (last?.at === this.total) this.resizes.pop();
    this.resizes.push({ cols, rows, at: this.total });
  }
  /** Resizes before stream byte `from` only set the size that byte is written at. */
  private foldResizes(from: number) {
    while (this.resizes[0] && this.resizes[0].at <= from) {
      const { cols, rows } = this.resizes[0];
      this.head = { cols, rows };
      this.resizes.shift();
    }
  }
  replay(): TailReplay {
    const len = Math.min(this.total, this.cap);
    const start = this.total - len;
    const bytes = new Uint8Array(len);
    const at = start % this.cap;
    const first = Math.min(len, this.cap - at);
    bytes.set(this.ring.subarray(at, at + first));
    bytes.set(this.ring.subarray(0, len - first), first);
    this.foldResizes(start);
    const steps: TailReplay['steps'] = [];
    let pos = 0;
    for (const { cols, rows, at: end } of this.resizes) {
      if (end > start + pos) steps.push(fromUtf8.decode(bytes.subarray(pos, end - start)));
      steps.push({ cols, rows });
      pos = end - start;
    }
    if (pos < len) steps.push(fromUtf8.decode(bytes.subarray(pos)));
    return { size: this.head, steps };
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
      const seed = tails.get(sessionId)?.replay();
      dispose(sessionId);
      const size = seed?.size ?? { cols, rows };
      const term = new Terminal({ ...size, allowProposedApi: true, scrollback });
      terms.set(sessionId, term);
      // xterm parses writes later but resizes at once: a resize waits for the bytes before it.
      const resizeInOrder = (to: Size) =>
        term.write('', () => {
          if (terms.get(sessionId) === term) term.resize(to.cols, to.rows);
        });
      for (const step of seed?.steps ?? []) {
        if (typeof step === 'string') term.write(step);
        else resizeInOrder(step);
      }
      if (seed) resizeInOrder({ cols, rows });
    },
    keepTail(sessionId, cols, rows) {
      dispose(sessionId);
      tails.set(sessionId, new OutputTail(tailBytes, { cols, rows }));
    },
    feed(sessionId, data) {
      const term = terms.get(sessionId);
      if (term) term.write(data);
      else tails.get(sessionId)?.push(data);
    },
    resize(sessionId, cols, rows) {
      const term = terms.get(sessionId);
      if (term) term.resize(cols, rows);
      else tails.get(sessionId)?.resize(cols, rows);
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
