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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    post({ type: 'term:start', sessionId, cols: term.cols, rows: term.rows, agentId, cwd });

    const onData = term.onData((data) => post({ type: 'term:input', sessionId, data }));
    const unsub = subscribe((msg) => {
      if (msg.type === 'term:data' && msg.sessionId === sessionId) {
        term.write(msg.data);
      } else if (msg.type === 'term:exit' && msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        post({ type: 'term:resize', sessionId, cols: term.cols, rows: term.rows });
      } catch {
        /* element detached */
      }
    });
    ro.observe(ref.current);

    return () => {
      onData.dispose();
      unsub();
      ro.disconnect();
      post({ type: 'term:dispose', sessionId });
      term.dispose();
    };
  }, [sessionId]);

  return <div className="termpane" ref={ref} />;
}
