import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { post, subscribe, logToHost } from '../bridge';

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
    logToHost(`TerminalPane mount (session=${sessionId})`);
    if (!ref.current) {
      logToHost('TerminalPane: ref not ready, aborting');
      return;
    }
    let term: Terminal;
    let fit: FitAddon;
    try {
      term = new Terminal({
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 1.35,
        cursorBlink: true,
        theme: THEME,
        allowProposedApi: true,
      });
      termRef.current = term;
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      logToHost('xterm opened');
    } catch (e) {
      logToHost(`xterm init FAILED: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

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

    // Start synchronously — effects run after layout, and rAF can be throttled
    // when the webview isn't visible at init. Fall back to 80x24 if the
    // container hasn't been sized yet; the ResizeObserver re-fits afterwards.
    safeFit();
    post({
      type: 'term:start',
      sessionId,
      cols: term.cols || 80,
      rows: term.rows || 24,
      agentId,
      cwd,
    });
    logToHost(`term:start posted (${term.cols || 80}x${term.rows || 24}, agent=${agentId ?? 'shell'})`);
    term.focus();

    // Re-fit shortly after in case the flex/grid layout settled late.
    const t = setTimeout(() => {
      safeFit();
      post({ type: 'term:resize', sessionId, cols: term.cols || 80, rows: term.rows || 24 });
    }, 80);

    const ro = new ResizeObserver(() => {
      safeFit();
      post({ type: 'term:resize', sessionId, cols: term.cols || 80, rows: term.rows || 24 });
    });
    ro.observe(ref.current);

    return () => {
      clearTimeout(t);
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
