import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
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
    if (!ref.current) return;
    let term: Terminal;
    let fit: FitAddon;
    try {
      term = new Terminal({
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 13,
        // lineHeight must be 1.0 so box-drawing characters (│ ┌ └) connect
        // vertically; extra leading breaks them into dashes.
        lineHeight: 1.0,
        cursorBlink: true,
        theme: THEME,
        allowProposedApi: true,
      });
      termRef.current = term;
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      // WebGL renderer draws box/block glyphs to fill the cell (crisper, robust).
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* fall back to the DOM renderer */
      }
    } catch (e) {
      logToHost(`xterm init failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    let started = false;

    // Only fit when the container is actually laid out with a real size — fitting
    // a hidden (display:none) pane yields a tiny/garbage column count, which makes
    // the PTY wrap at ~2 columns (mangled output). Returns true if a real fit ran.
    const fitIfVisible = (): boolean => {
      const el = ref.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return false;
      try {
        fit.fit();
      } catch {
        return false;
      }
      return true;
    };

    const onData = term.onData((data) => post({ type: 'term:input', sessionId, data }));
    const unsub = subscribe((msg) => {
      if (msg.type === 'term:data' && msg.sessionId === sessionId) {
        term.write(msg.data);
      } else if (msg.type === 'term:exit' && msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
      }
    });

    // Start the PTY on first real visibility (so it launches at the correct size),
    // and resize it on every subsequent layout change.
    const sync = () => {
      if (!fitIfVisible()) return;
      if (!started) {
        started = true;
        post({ type: 'term:start', sessionId, cols: term.cols, rows: term.rows, agentId, cwd });
        term.focus();
      } else {
        post({ type: 'term:resize', sessionId, cols: term.cols, rows: term.rows });
      }
    };

    const ro = new ResizeObserver(() => sync());
    ro.observe(ref.current);
    sync(); // attempt immediately for the already-visible (active) pane

    return () => {
      onData.dispose();
      unsub();
      ro.disconnect();
      if (started) post({ type: 'term:dispose', sessionId });
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return <div className="termpane" ref={ref} onMouseDown={() => termRef.current?.focus()} />;
}
