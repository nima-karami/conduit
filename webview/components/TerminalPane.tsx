import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { post, subscribe } from '../bridge';

const THEME = {
  background: '#0a0b0e',
  foreground: '#d7dae1',
  cursor: '#d9775c',
  cursorAccent: '#0a0b0e',
  selectionBackground: 'rgba(217,119,92,0.3)',
  black: '#15171c',
  red: '#e0726f',
  green: '#6cc18a',
  yellow: '#d9a14b',
  blue: '#5e9bd6',
  magenta: '#d9775c',
  cyan: '#67c1c0',
  white: '#d7dae1',
  brightBlack: '#585e6a',
};

export function TerminalPane({
  sessionId,
  agentId,
  cwd,
}: {
  sessionId: string;
  agentId?: string;
  cwd?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not laid out yet */
      }
    };

    // Listeners must be live BEFORE we ask the host to start the PTY, so no
    // early output is dropped.
    const onData = term.onData((data) => post({ type: 'term:input', sessionId, data }));
    const unsub = subscribe((msg) => {
      if (msg.type === 'term:data' && msg.sessionId === sessionId) {
        term.write(msg.data);
      } else if (msg.type === 'term:exit' && msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
      }
    });

    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      safeFit();
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      post({ type: 'term:start', sessionId, cols, rows, agentId, cwd });
      term.focus();
    };
    // Defer one frame so the grid/flex layout has given the container a size
    // (otherwise fit() yields 0 rows and nothing renders).
    const raf = requestAnimationFrame(() => requestAnimationFrame(start));

    const ro = new ResizeObserver(() => {
      safeFit();
      if (started) post({ type: 'term:resize', sessionId, cols: term.cols || 80, rows: term.rows || 24 });
    });
    ro.observe(ref.current);

    return () => {
      cancelAnimationFrame(raf);
      onData.dispose();
      unsub();
      ro.disconnect();
      post({ type: 'term:dispose', sessionId });
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return (
    <div
      className="termpane"
      ref={ref}
      onMouseDown={() => termRef.current?.focus()}
    />
  );
}
