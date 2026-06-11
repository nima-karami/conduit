import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { logToHost, post, subscribe } from '../bridge';
import { useSettings } from '../settings';
import { buildXtermTheme, monoStack } from '../xterm-theme';
import { disposeTerminal } from './safe-dispose';

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
  const fitRef = useRef<FitAddon | null>(null);
  const { settings } = useSettings();

  useEffect(() => {
    if (!ref.current) return;
    let term: Terminal;
    let fit: FitAddon;
    let webgl: WebglAddon | null = null;
    try {
      term = new Terminal({
        fontFamily: monoStack(settings.fontMono),
        fontSize: 13,
        // lineHeight must be 1.0 so box-drawing characters (│ ┌ └) connect
        // vertically; extra leading breaks them into dashes.
        lineHeight: 1.0,
        cursorBlink: true,
        theme: buildXtermTheme(),
        allowProposedApi: true,
        // Let the animated app backdrop show through the terminal (surface opacity).
        allowTransparency: true,
      });
      termRef.current = term;
      fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(ref.current);
      // WebGL renderer draws box/block glyphs to fill the cell (crisper, robust).
      try {
        webgl = new WebglAddon();
        // On context loss tear the addon down through the guarded path so a
        // throw during that teardown can't escape (it falls back to the DOM
        // renderer instead).
        const lost = webgl;
        webgl.onContextLoss(() => disposeTerminal(null, [lost]));
        term.loadAddon(webgl);
      } catch {
        webgl = null;
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
      // Each step is independently guarded so a single failing teardown can't
      // abort the rest (and can't throw out of React cleanup -> black screen).
      // The WebGL addon is the throwy one (its dispose reads `_isDisposed`,
      // undefined when the GL context never fully initialized); dispose addons
      // before the terminal that owns them.
      try {
        onData.dispose();
      } catch {
        /* listener may already be gone */
      }
      try {
        unsub();
      } catch {
        /* no-op */
      }
      ro.disconnect();
      if (started) post({ type: 'term:dispose', sessionId });
      disposeTerminal(term, [webgl, fit]);
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, agentId, settings.fontMono, cwd]);

  // Re-theme + re-font the live terminal when the app theme / mono font changes.
  // rAF so SettingsProvider's data-theme attribute is applied before we read CSS vars.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const id = requestAnimationFrame(() => {
      term.options.theme = buildXtermTheme();
      term.options.fontFamily = monoStack(settings.fontMono);
      const el = ref.current;
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
        try {
          fitRef.current?.fit();
          post({ type: 'term:resize', sessionId, cols: term.cols, rows: term.rows });
        } catch {
          /* not visible yet */
        }
      }
    });
    return () => cancelAnimationFrame(id);
  }, [settings.fontMono, sessionId]);

  return <div className="termpane" ref={ref} onMouseDown={() => termRef.current?.focus()} />;
}
