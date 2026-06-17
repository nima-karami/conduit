import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { logToHost, post, subscribe } from '../bridge';
import { fontZoomTarget } from '../font-zoom';
import { IconCopy, IconEraser, IconPaste, IconSearch } from '../icons';
import { useSettings } from '../settings';
import { buildTerminalMenuItems, type TerminalMenuAction } from '../term-menu';
import { initialTermSearchState, termSearchReducer } from '../term-search';
import { terminalClipboardAction } from '../terminal-clipboard';
import { detectPathTokens } from '../terminal-links';
import { isViewportAtBottom } from '../terminal-scroll';
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

// macOS uses Cmd for copy/paste and reserves Ctrl+C for SIGINT; elsewhere Ctrl+C
// copies only when a selection exists. Drives terminalClipboardAction.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function TerminalPane({
  sessionId,
  agentId,
  cwd,
  onOpenFile,
  onRevealFolder,
}: {
  sessionId: string;
  agentId?: string;
  cwd?: string;
  /** Called when a file path link is clicked: absolute path + optional position. */
  onOpenFile?: (path: string, line?: number, col?: number) => void;
  /** Called when a folder path link is clicked: opens the OS file manager at that path. */
  onRevealFolder?: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const { settings, update } = useSettings();

  const [search, dispatchSearch] = useReducer(termSearchReducer, initialTermSearchState);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Live mirror so the init effect can read the current zoom size without depending on
  // it (a dep would recreate the terminal — and kill the PTY — on every zoom step).
  const termFontRef = useRef(settings.terminalFontSize);
  termFontRef.current = settings.terminalFontSize;

  // Live refs so the link callbacks always use the latest cwd and callbacks
  // without depending on them as effect deps (which would recreate the terminal).
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onRevealFolderRef = useRef(onRevealFolder);
  onRevealFolderRef.current = onRevealFolder;

  useEffect(() => {
    if (!ref.current) return;
    let term: Terminal;
    let fit: FitAddon;
    let search: SearchAddon;
    let webgl: WebglAddon | null = null;
    try {
      term = new Terminal({
        fontFamily: monoStack(settings.fontMono),
        // Initial size; live zoom (Ctrl/Cmd +/-/0) flows through the effect below so a
        // size change never tears down the PTY. Read via ref so it stays out of deps.
        fontSize: termFontRef.current,
        // lineHeight must be 1.0 so box-drawing characters (│ ┌ └) connect
        // vertically; extra leading breaks them into dashes.
        lineHeight: 1.0,
        cursorBlink: true,
        // The xterm canvas is fully transparent (R4.3b); the configurable surface
        // (colour × code opacity) lives on the translucent `.termwrap` container via
        // `--term-surface`, so the canvas needn't carry the colour and opacity changes
        // cascade through CSS without re-theming. The re-theme effect below still
        // re-applies foreground/ANSI colours live on app-theme/font changes.
        theme: buildXtermTheme(),
        allowProposedApi: true,
        // Transparent canvas so the translucent container surface (and the animated
        // app backdrop behind it) shows through the terminal.
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

    // D11 — Path link provider. Only registered when the host bridge is present
    // (window.agentDeck), because the preview has no filesystem to stat paths against.
    let linkProviderDisposable: { dispose(): void } | null = null;
    let unsubPathExists: (() => void) | null = null;
    if (window.agentDeck) {
      // Cache of known path existence results to avoid redundant IPC round-trips
      // for paths that appear repeatedly across lines. Map: path → { exists, isDir }.
      const existenceCache = new Map<string, { exists: boolean; isDir: boolean }>();
      // In-flight IPC requests: path → array of callbacks waiting for the result.
      const pending = new Map<string, Array<(r: { exists: boolean; isDir: boolean }) => void>>();

      // Subscribe to pathExistsResult replies. Stored for cleanup in teardown.
      unsubPathExists = subscribe((msg) => {
        if (msg.type !== 'pathExistsResult') return;
        const result = { exists: msg.exists, isDir: msg.isDir };
        existenceCache.set(msg.path, result);
        const cbs = pending.get(msg.path);
        if (cbs) {
          pending.delete(msg.path);
          for (const cb of cbs) cb(result);
        }
      });

      // Request path existence from the host; resolves via the subscription above.
      const checkExists = (path: string): Promise<{ exists: boolean; isDir: boolean }> => {
        const cached = existenceCache.get(path);
        if (cached) return Promise.resolve(cached);
        return new Promise((resolve) => {
          let cbs = pending.get(path);
          if (!cbs) {
            cbs = [];
            pending.set(path, cbs);
            post({ type: 'pathExists', path });
          }
          cbs.push(resolve);
        });
      };

      linkProviderDisposable = term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const line = term.buffer.active.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          const text = line.translateToString(true);
          const tokens = detectPathTokens(text, cwdRef.current);
          if (tokens.length === 0) {
            callback(undefined);
            return;
          }

          // Check existence for all tokens asynchronously, then call back with
          // only the tokens that point to real paths.
          void Promise.all(
            tokens.map(async (tok) => {
              const result = await checkExists(tok.path);
              return result.exists ? { tok, isDir: result.isDir } : null;
            }),
          ).then((results) => {
            const links = results
              .filter((r): r is { tok: (typeof tokens)[number]; isDir: boolean } => r !== null)
              .map(({ tok, isDir }) => ({
                range: {
                  start: { x: tok.start + 1, y: bufferLineNumber },
                  end: { x: tok.end, y: bufferLineNumber },
                },
                text: text.slice(tok.start, tok.end),
                decorations: { pointerCursor: true, underline: false },
                activate(_event: MouseEvent, _text: string) {
                  if (isDir) {
                    onRevealFolderRef.current?.(tok.path);
                  } else {
                    onOpenFileRef.current?.(tok.path, tok.line, tok.col);
                  }
                },
                hover(_event: MouseEvent, _text: string) {
                  this.decorations = { pointerCursor: true, underline: true };
                },
                leave(_event: MouseEvent, _text: string) {
                  this.decorations = { pointerCursor: true, underline: false };
                },
              }));
            callback(links.length > 0 ? links : undefined);
          });
        },
      });
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
    // The app running in the terminal can set its window title (OSC 0/2); forward it so
    // the host can sync the session label (e.g. Claude Code, incl. a live /rename).
    const onTitle = term.onTitleChange((title) => post({ type: 'term:title', sessionId, title }));
    // Write, keeping the view pinned to the bottom when the user was already following
    // output. Captured BEFORE the write so a large/chunked write (which can defeat
    // xterm's own auto-follow and strand the user mid-scroll) re-pins afterwards; if the
    // user had scrolled up, we leave their position alone.
    const writeAndStick = (data: string) => {
      const buf = term.buffer.active;
      const stick = isViewportAtBottom(buf.viewportY, buf.baseY);
      term.write(data, stick ? () => term.scrollToBottom() : undefined);
    };
    const unsub = subscribe((msg) => {
      if (msg.type === 'term:data' && msg.sessionId === sessionId) {
        writeAndStick(msg.data);
      } else if (msg.type === 'term:exit' && msg.sessionId === sessionId) {
        writeAndStick(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
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
        onTitle.dispose();
      } catch {
        /* listener may already be gone */
      }
      try {
        unsub();
      } catch {
        /* no-op */
      }
      try {
        unsubPathExists?.();
      } catch {
        /* no-op */
      }
      try {
        linkProviderDisposable?.dispose();
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

  // Refit the terminal to its container and tell the host the new cols/rows — but only
  // when the pane is actually visible (fitting a hidden pane yields a garbage column
  // count). Shared by the re-theme/font effect and the zoom effect below.
  const refitVisibleTerminal = useCallback(() => {
    const term = termRef.current;
    const el = ref.current;
    if (!term || !el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    try {
      fitRef.current?.fit();
      post({ type: 'term:resize', sessionId, cols: term.cols, rows: term.rows });
    } catch {
      /* not visible yet */
    }
  }, [sessionId]);

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
      refitVisibleTerminal();
    });
    return () => cancelAnimationFrame(id);
  }, [settings.fontMono, settings.surfaceColor, refitVisibleTerminal]);

  // Live-apply the terminal zoom (Ctrl/Cmd +/-/0 → settings.terminalFontSize) to the
  // running terminal and refit so the PTY's col/row count tracks the new glyph size.
  // Separate from init so a zoom never recreates the terminal (which would kill the PTY).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.terminalFontSize;
    refitVisibleTerminal();
  }, [settings.terminalFontSize, refitVisibleTerminal]);

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

  // Paste via xterm's paste() so bracketed-paste mode is honoured: a multi-line
  // paste reaches a TUI (e.g. Claude Code) as ONE atomic paste wrapped in
  // ESC[200~/ESC[201~, instead of N lines each acting like Enter. Posting raw text
  // via term:input would bypass that wrapping. (The app also removes the native Edit
  // menu — Menu.setApplicationMenu(null) — so Ctrl/Cmd+V has no accelerator and never
  // fires a native paste; the keydown handler below calls this explicitly.)
  const pasteFromClipboard = () => {
    const term = termRef.current;
    if (!term) return;
    void (async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) term.paste(text);
      } catch {
        pushToast({ message: 'Paste failed: clipboard is unavailable.', variant: 'error' });
      }
    })();
  };

  // Copy the current selection to the clipboard and clear it (so a following Ctrl+C
  // with no selection passes through to the shell as SIGINT). No-op without a selection.
  const copySelection = () => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      void navigator.clipboard?.writeText(sel);
      term.clearSelection();
    }
  };

  // Run a context-menu action against the live terminal. Copy guards the clipboard
  // API and toasts on failure rather than throwing.
  const runMenuAction = (action: TerminalMenuAction) => {
    const term = termRef.current;
    if (!term) return;
    if (action === 'copy') {
      copySelection();
    } else if (action === 'paste') {
      pasteFromClipboard();
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
        // when no terminal is focused. See docs/specs/archive/2026-06-11-terminal-ergonomics.md.
        onKeyDownCapture={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          // Ctrl/Cmd +/-/0 zoom the terminal content font (capture phase so xterm
          // doesn't also receive the key). Persisted via settings → all terminals match.
          const zoom = fontZoomTarget(settings.terminalFontSize, e);
          if (zoom !== null) {
            e.preventDefault();
            e.stopPropagation();
            update({ terminalFontSize: zoom });
            return;
          }
          // Copy/paste. The app removes the native Edit menu (Menu.setApplicationMenu
          // (null)) so these have no accelerator and xterm never sees a clipboard event;
          // handle them here (capture phase + stopPropagation so xterm doesn't also send
          // a raw ^C/^V). Paste routes through xterm's bracketed paste(); copy reads the
          // selection. Ctrl+C with no selection returns null → falls through as SIGINT.
          const clip = termRef.current
            ? terminalClipboardAction(e, termRef.current.hasSelection(), IS_MAC)
            : null;
          if (clip === 'copy') {
            e.preventDefault();
            e.stopPropagation();
            copySelection();
            return;
          }
          if (clip === 'paste') {
            e.preventDefault();
            e.stopPropagation();
            pasteFromClipboard();
            return;
          }
          if (mod && !e.altKey && (e.key === 'f' || e.key === 'F')) {
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
