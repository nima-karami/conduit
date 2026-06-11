import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useReducer, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { logToHost, post, subscribe } from '../bridge';
import { IconCopy, IconEraser, IconPaste, IconSearch } from '../icons';
import { useSettings } from '../settings';
import { buildTerminalMenuItems, type TerminalMenuAction } from '../term-menu';
import { initialTermSearchState, termSearchReducer } from '../term-search';
import { pushToast } from '../toast-store';
import { buildXtermTheme, monoStack } from '../xterm-theme';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { disposeTerminal } from './safe-dispose';
import { TermSearchBar } from './term-search-bar';

const MENU_ICONS = {
  copy: <IconCopy size={14} />,
  paste: <IconPaste size={14} />,
  search: <IconSearch size={14} />,
  clear: <IconEraser size={14} />,
} as const;

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
  const searchRef = useRef<SearchAddon | null>(null);
  const { settings } = useSettings();

  const [search, dispatchSearch] = useReducer(termSearchReducer, initialTermSearchState);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    let term: Terminal;
    let fit: FitAddon;
    let search: SearchAddon;
    let webgl: WebglAddon | null = null;
    try {
      term = new Terminal({
        fontFamily: monoStack(settings.fontMono),
        fontSize: 13,
        // lineHeight must be 1.0 so box-drawing characters (│ ┌ └) connect
        // vertically; extra leading breaks them into dashes.
        lineHeight: 1.0,
        cursorBlink: true,
        // Initial theme reads the live --term-bg CSS var (already applied by
        // SettingsProvider). Live recolours go through the re-theme effect below,
        // which passes settings.surfaceColor explicitly — so this effect needn't
        // depend on it and the terminal isn't torn down on every colour change.
        theme: buildXtermTheme(),
        allowProposedApi: true,
        // Let the animated app backdrop show through the terminal (surface opacity).
        allowTransparency: true,
      });
      termRef.current = term;
      fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      // Find-in-terminal (L4). Registered before open so its decorations attach;
      // torn down in the same guarded disposeTerminal path as fit/webgl below.
      search = new SearchAddon();
      searchRef.current = search;
      term.loadAddon(search);
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
      // Search addon joins the guarded teardown alongside webgl/fit (addons before
      // the terminal that owns them) — never regress this isolation.
      disposeTerminal(term, [webgl, fit, search]);
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [sessionId, agentId, settings.fontMono, cwd]);

  // Re-theme + re-font the live terminal when the app theme / mono font / shared
  // surface colour changes — so the terminal background recolours in place to keep
  // matching the code block (wishlist I1), not only on new terminals.
  // rAF so SettingsProvider's data-theme attribute is applied before we read CSS vars.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const id = requestAnimationFrame(() => {
      term.options.theme = buildXtermTheme(settings.surfaceColor);
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
  }, [settings.fontMono, settings.surfaceColor, sessionId]);

  // Run the active SearchAddon for the current query/direction. Re-runs on every
  // setQuery/next/prev so typing live-searches and the arrows step matches.
  useEffect(() => {
    const addon = searchRef.current;
    if (!addon || !search.open || !search.query) return;
    try {
      if (search.direction === 'prev') addon.findPrevious(search.query);
      else addon.findNext(search.query);
    } catch {
      /* addon may be mid-teardown; ignore */
    }
  }, [search]);

  const focusTerminal = () => termRef.current?.focus();

  const closeSearch = () => {
    dispatchSearch({ type: 'close' });
    try {
      searchRef.current?.clearDecorations();
    } catch {
      /* no-op */
    }
    focusTerminal();
  };

  // Run a context-menu action against the live terminal. Copy/Paste guard the
  // clipboard API and toast on failure rather than throwing.
  const runMenuAction = (action: TerminalMenuAction) => {
    const term = termRef.current;
    if (!term) return;
    if (action === 'copy') {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard?.writeText(sel);
    } else if (action === 'paste') {
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) post({ type: 'term:input', sessionId, data: text });
        } catch {
          pushToast({ message: 'Paste failed: clipboard is unavailable.', variant: 'error' });
        }
      })();
    } else if (action === 'clear') {
      term.clear();
    } else if (action === 'find') {
      dispatchSearch({ type: 'open' });
    }
  };

  // Build the shared portal-menu items from the terminal context, snapshotting the
  // selection at open time so Copy reflects what the user sees.
  const openContextMenu = (e: React.MouseEvent) => {
    const term = termRef.current;
    if (!term) return;
    // xterm attaches its own contextmenu/mousedown handling and on Windows the
    // right button can extend the selection; preventDefault stops the OS menu and
    // xterm's default so only our menu opens.
    e.preventDefault();
    const canPaste = typeof navigator.clipboard?.readText === 'function';
    const specs = buildTerminalMenuItems({ hasSelection: term.hasSelection(), canPaste });
    const items: MenuItem[] = specs.map((s) => ({
      label: s.label,
      icon: MENU_ICONS[s.iconKey],
      disabled: s.disabled,
      separatorBefore: s.separatorBefore,
      onClick: () => runMenuAction(s.action),
    }));
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div className="termpane-wrap">
      <div
        className="termpane"
        ref={ref}
        onMouseDown={focusTerminal}
        onContextMenu={openContextMenu}
        // Mod+F opens the find bar — terminal-LOCAL only (capture phase, scoped to
        // this container) so it never collides with Monaco's global find or fires
        // when no terminal is focused. See docs/specs/terminal-ergonomics.md.
        onKeyDownCapture={(e) => {
          if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            e.stopPropagation();
            dispatchSearch({ type: 'open' });
          }
        }}
      />
      {search.open && (
        <TermSearchBar
          query={search.query}
          onQueryChange={(q) => dispatchSearch({ type: 'setQuery', query: q })}
          onNext={() => dispatchSearch({ type: 'next' })}
          onPrev={() => dispatchSearch({ type: 'prev' })}
          onClose={closeSearch}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
