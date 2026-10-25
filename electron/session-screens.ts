import { Terminal } from '@xterm/headless';
import type { ScreenSnapshot } from '../src/conduit-mcp/screen-verdict';

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
  const scrollback = opts.scrollback ?? 0;

  const dispose = (sessionId: string) => {
    terms.get(sessionId)?.dispose();
    terms.delete(sessionId);
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
        term.write('', () => {
          if (terms.get(sessionId) !== term) {
            resolve(undefined);
            return;
          }
          const buf = term.buffer.active;
          const lines: string[] = [];
          for (let y = 0; y < term.rows; y += 1) {
            lines.push(
              buf
                .getLine(buf.viewportY + y)
                ?.translateToString(true)
                .trimEnd() ?? '',
            );
          }
          resolve({ lines, cursorY: buf.cursorY + buf.baseY - buf.viewportY });
        });
      });
    },
    has(sessionId) {
      return terms.has(sessionId);
    },
  };
}
