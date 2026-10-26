import { type IBufferLine, Terminal } from '@xterm/headless';
import { type ScreenSnapshot, STYLE_DIM, STYLE_PLAIN } from '../src/conduit-mcp/screen-verdict';

/** translateToString(true).trimEnd(), plus a style mask aligned with it char-for-char. */
function readRow(line: IBufferLine | undefined, cols: number): { text: string; styles: string } {
  if (!line) return { text: '', styles: '' };
  let text = '';
  let styles = '';
  const cell = line.getCell(0);
  for (let x = 0; x < cols && cell; x += 1) {
    line.getCell(x, cell);
    // The trailing half of a wide char: translateToString skips it too.
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    text += chars;
    styles += (cell.isDim() ? STYLE_DIM : STYLE_PLAIN).repeat(chars.length);
  }
  const trimmed = text.trimEnd();
  return { text: trimmed, styles: styles.slice(0, trimmed.length) };
}

/**
 * Host-side screen models for sessions with messaging: the gate needs the rendered screen, and
 * the PTY's raw tail can't rebuild a differentially repainted one (spec §2 "Screen model").
 * Headless only — never a renderer xterm or a WebGL addon (CLAUDE.md, Terminal).
 */
export interface SessionScreens {
  start(sessionId: string, cols: number, rows: number): void;
  feed(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  dispose(sessionId: string): void;
  snapshot(sessionId: string): Promise<ScreenSnapshot | undefined>;
  has(sessionId: string): boolean;
}

export function createSessionScreens(opts: { scrollback?: number } = {}): SessionScreens {
  const terms = new Map<string, Terminal>();
  /** Snapshots waiting on a model's write callback, per model. */
  const waiting = new Map<Terminal, Set<(s: ScreenSnapshot | undefined) => void>>();
  const scrollback = opts.scrollback ?? 0;

  // A disposed model answers its waiters now: xterm may parse the dead backlog first, or never
  // call back, and the gate must not wait on a session that is gone.
  const dispose = (sessionId: string) => {
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
      dispose(sessionId);
      terms.set(sessionId, new Terminal({ cols, rows, allowProposedApi: true, scrollback }));
    },
    feed(sessionId, data) {
      terms.get(sessionId)?.write(data);
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
          const styles: string[] = [];
          for (let y = 0; y < term.rows; y += 1) {
            const row = readRow(buf.getLine(buf.viewportY + y), term.cols);
            lines.push(row.text);
            styles.push(row.styles);
          }
          resolve({ lines, styles, cursorY: buf.cursorY + buf.baseY - buf.viewportY });
        });
      });
    },
    has(sessionId) {
      return terms.has(sessionId);
    },
  };
}
