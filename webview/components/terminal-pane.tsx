import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { logToHost, pathForDroppedFile, post, subscribe } from '../bridge';
import { fontZoomTarget } from '../font-zoom';
import { IconCopy, IconEraser, IconPaste, IconSearch } from '../icons';
import { useSettings } from '../settings';
import { buildTerminalMenuItems, type TerminalMenuAction } from '../term-menu';
import { initialTermSearchState, termSearchReducer } from '../term-search';
import { terminalClipboardAction } from '../terminal-clipboard';
import { formatPathForTerminal, TERMINAL_PATH_MIME } from '../terminal-drop';
import { detectPathTokens } from '../terminal-links';
import { isViewportAtBottom, shouldHandleWheelLocally, wheelScrollLines } from '../terminal-scroll';
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
const IS_WINDOWS = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);

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
  const [pathDragOver, setPathDragOver] = useState(false);
  // Read at mount without becoming an effect dep (a dep would recreate the terminal —
  // and kill the PTY — on every zoom step).
  const termFontRef = useRef(settings.terminalFontSize);
  termFontRef.current = settings.terminalFontSize;
  const fontMonoRef = useRef(settings.fontMono);
  fontMonoRef.current = settings.fontMono;

  // Refs so the latest cwd/agentId/callbacks are read without becoming init-effect
  // deps. The init effect creates the xterm terminal AND starts the PTY, so any dep
  // that changes after mount would tear the terminal down and KILL the live PTY — and
  // a ConPTY child re-spawned immediately after that kill dies with
  // STATUS_CONTROL_C_EXIT (observed as a new PowerShell session "crashing" on launch).
  // The terminal/PTY lifecycle is therefore keyed on sessionId alone.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
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
        fontFamily: monoStack(fontMonoRef.current),
        fontSize: termFontRef.current,
        // Must be 1.0 so box-drawing characters (│ ┌ └) connect vertically; extra
        // leading breaks them into dashes.
        lineHeight: 1.0,
        cursorBlink: true,
        // Canvas stays transparent (R4.3b); the configurable surface (colour × opacity)
        // lives on the `.termwrap` container via `--term-surface`, so opacity changes
        // cascade through CSS without re-theming. The re-theme effect below still
        // re-applies foreground/ANSI colours on app-theme/font changes.
        theme: buildXtermTheme(),
        allowProposedApi: true,
        // Transparent so the container surface and animated app backdrop show through.
        allowTransparency: true,
      });
      termRef.current = term;
      fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      // Find-in-terminal (L4). Registered before open so its decorations attach.
      search = new SearchAddon();
      searchRef.current = search;
      term.loadAddon(search);
      term.open(ref.current);
      // WebGL renderer draws box/block glyphs to fill the cell (crisper).
      try {
        webgl = new WebglAddon();
        // Tear down through the guarded path on context loss so a throw can't escape
        // (it falls back to the DOM renderer).
        const lost = webgl;
        webgl.onContextLoss(() => disposeTerminal(null, [lost]));
        term.loadAddon(webgl);
      } catch {
        webgl = null;
        /* fall back to the DOM renderer */
      }
      // Restore wheel scrollback scrolling when a TUI (e.g. Claude Code) enables mouse
      // tracking: xterm then forwards the wheel to the app and stops scrolling history,
      // stranding a user who scrolled up in the normal buffer (only a keystroke escapes,
      // via scrollOnUserInput). We take the wheel back exactly in that case and otherwise
      // leave xterm's native handling alone (see terminal-scroll.ts). `wheelPartial`
      // accumulates the sub-line pixel remainder across events so trackpad scrolling stays
      // smooth.
      let wheelPartial = 0;
      term.attachCustomWheelEventHandler((ev) => {
        const buf = term.buffer.active;
        if (!shouldHandleWheelLocally(buf.type, term.modes.mouseTrackingMode, ev.shiftKey)) {
          return true;
        }
        const screen = ref.current?.querySelector('.xterm-screen');
        const rowHeight = screen && term.rows > 0 ? screen.clientHeight / term.rows : 0;
        const { lines, partial } = wheelScrollLines(
          ev.deltaY,
          ev.deltaMode,
          rowHeight,
          term.rows,
          wheelPartial,
        );
        wheelPartial = partial;
        if (lines !== 0) term.scrollLines(lines);
        return false;
      });
    } catch (e) {
      logToHost(`xterm init failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // D11 — Path link provider. Only with the host bridge present; the preview has no
    // filesystem to stat paths against.
    let linkProviderDisposable: { dispose(): void } | null = null;
    let unsubPathExists: (() => void) | null = null;
    if (window.agentDeck) {
      // path → result, to avoid redundant IPC round-trips for repeated paths.
      const existenceCache = new Map<string, { exists: boolean; isDir: boolean }>();
      // In-flight requests: path → callbacks waiting for the result.
      const pending = new Map<string, Array<(r: { exists: boolean; isDir: boolean }) => void>>();

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

          // Call back with only the tokens that point to real paths.
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

    // Fit only when the container has a real laid-out size — fitting a hidden pane
    // yields a garbage column count that wraps the PTY at ~2 columns (mangled output).
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
    // Forward OSC 0/2 title changes so the host can sync the session label (incl. /rename).
    const onTitle = term.onTitleChange((title) => post({ type: 'term:title', sessionId, title }));
    // Capture the at-bottom state BEFORE the write: a large/chunked write can defeat
    // xterm's own auto-follow and strand a following user mid-scroll, so re-pin after.
    // If the user had scrolled up, leave their position alone.
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

    // Start the PTY on first real visibility (so it launches at the correct size);
    // resize on every subsequent layout change.
    const sync = () => {
      if (!fitIfVisible()) return;
      if (!started) {
        started = true;
        post({
          type: 'term:start',
          sessionId,
          cols: term.cols,
          rows: term.rows,
          agentId: agentIdRef.current,
          cwd: cwdRef.current,
        });
        term.focus();
      } else {
        post({ type: 'term:resize', sessionId, cols: term.cols, rows: term.rows });
      }
    };

    const ro = new ResizeObserver(() => sync());
    ro.observe(ref.current);
    sync(); // attempt immediately for the already-visible (active) pane

    return () => {
      // Each step is independently guarded so one failing teardown can't abort the rest
      // (and can't throw out of React cleanup -> black screen). The WebGL addon is the
      // throwy one (its dispose reads `_isDisposed`, undefined if the GL context never
      // initialized); dispose addons before the terminal that owns them.
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
      disposeTerminal(term, [webgl, fit, search]);
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // Keyed on sessionId ONLY: agentId/cwd/fontMono are read via refs (above) or
    // applied live by the re-theme/zoom effects below, so they never recreate the
    // terminal and kill the PTY. See the cwdRef/agentIdRef note for the crash this avoids.
  }, [sessionId]);

  // Refit and report the new cols/rows, but only when the pane is visible (fitting a
  // hidden pane yields a garbage column count). Shared by the effects below.
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

  // Re-theme/re-font the live terminal on theme/mono-font/surface-colour change so its
  // background recolours in place to keep matching the code block (wishlist I1).
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

  // Live-apply zoom and refit so the PTY's col/row tracks the new glyph size. Separate
  // from init so a zoom never recreates the terminal (which would kill the PTY).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.terminalFontSize;
    refitVisibleTerminal();
  }, [settings.terminalFontSize, refitVisibleTerminal]);

  // Re-run the search on every query/direction change so typing live-searches and the
  // arrows step matches.
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

  // A path drag = either the Files explorer (tagged TERMINAL_PATH_MIME) or the OS
  // (real File objects under 'Files'). Plain text/HTML drags are ignored.
  const isPathDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(TERMINAL_PATH_MIME) || e.dataTransfer.types.includes('Files');
  const onPathDragOver = (e: React.DragEvent) => {
    if (!isPathDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!pathDragOver) setPathDragOver(true);
  };
  const onPathDragLeave = (e: React.DragEvent) => {
    // Ignore leaves into descendant nodes (xterm canvas/textarea); only clear when the
    // pointer exits the terminal container.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setPathDragOver(false);
  };
  const onPathDrop = (e: React.DragEvent) => {
    if (!isPathDrag(e)) return;
    e.preventDefault();
    setPathDragOver(false);
    const term = termRef.current;
    if (!term) return;
    // OS drop carries one or more real files; the explorer drop carries a single path.
    const osPaths = Array.from(e.dataTransfer.files ?? [])
      .map((f) => pathForDroppedFile(f))
      .filter(Boolean);
    const paths = osPaths.length > 0 ? osPaths : [e.dataTransfer.getData(TERMINAL_PATH_MIME)];
    const text = paths
      .filter(Boolean)
      .map((p) => formatPathForTerminal(p, IS_WINDOWS))
      .join('');
    if (!text) return;
    // paste() honours bracketed-paste mode so the path lands on the input line (not
    // executed) and TUIs receive it as one atomic paste.
    term.paste(text);
    focusTerminal();
  };

  const closeSearch = () => {
    dispatchSearch({ type: 'close' });
    try {
      searchRef.current?.clearDecorations();
    } catch {
      /* no-op */
    }
    focusTerminal();
  };

  // Paste via xterm's paste() so bracketed-paste mode is honoured: a multi-line paste
  // reaches a TUI (e.g. Claude Code) as ONE atomic paste wrapped in ESC[200~/ESC[201~,
  // not N lines each acting like Enter. Raw text via term:input would bypass that.
  // The app removes the native Edit menu (Menu.setApplicationMenu(null)), so Ctrl/Cmd+V
  // has no accelerator and never fires a native paste — the keydown handler calls this.
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

  const openContextMenu = (e: React.MouseEvent) => {
    const term = termRef.current;
    if (!term) return;
    // On Windows the right button can extend xterm's selection; preventDefault stops the
    // OS menu and xterm's default so only our menu opens.
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
        className={`termpane${pathDragOver ? ' termpane--dragover' : ''}`}
        ref={ref}
        onMouseDown={focusTerminal}
        onContextMenu={openContextMenu}
        onDragOver={onPathDragOver}
        onDragLeave={onPathDragLeave}
        onDrop={onPathDrop}
        // Mod+F opens the find bar — terminal-LOCAL (capture phase, scoped here) so it
        // never collides with Monaco's global find or fires with no terminal focused.
        // See docs/specs/archive/2026-06-11-terminal-ergonomics.md.
        onKeyDownCapture={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          // Capture phase so xterm doesn't also receive the zoom key.
          const zoom = fontZoomTarget(settings.terminalFontSize, e);
          if (zoom !== null) {
            e.preventDefault();
            e.stopPropagation();
            update({ terminalFontSize: zoom });
            return;
          }
          // No native Edit menu means no clipboard accelerator, so handle copy/paste
          // here (capture + stopPropagation so xterm doesn't also send a raw ^C/^V).
          // Ctrl+C with no selection returns null → falls through to the shell as SIGINT.
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
