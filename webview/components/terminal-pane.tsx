import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { type ILinkProvider, Terminal } from '@xterm/xterm';
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { FILE_INDEX_TTL_MS } from '../../src/file-index-ttl';
import { folderKey } from '../../src/folder-key';
import {
  type InputBoxPrompt,
  inPromptEcho,
  inputBoxTop,
  type RowView,
} from '../../src/input-box-rows';
import { classifyLinkUri, dispatchLinkUri, type LinkUriSinks } from '../../src/link-target';
import { isAncestorOf } from '../../src/owning-session';
import type { ResolveRoot } from '../../src/path-link-roots';
import type { PathCandidate, TokenResolution } from '../../src/path-resolve';
import type { HostToWebview, TermGeometry } from '../../src/protocol';
import { withTimeout } from '../../src/with-timeout';
import {
  logToHost,
  openExternal,
  pathForDroppedFile,
  post,
  subscribe,
  windowsPty,
} from '../bridge';
import type { OpenMode } from '../docs';
import { fontZoomTarget } from '../font-zoom';
import {
  IconCopy,
  IconDoc,
  IconEraser,
  IconExternal,
  IconPaste,
  IconSearch,
  IconTerminal,
} from '../icons';
import { isMiddleButton, terminalLinkMiddleAction } from '../middle-click';
import { chooseClickAction, rankCandidates } from '../path-candidate-rank';
import { probePathKind } from '../path-probe';
import { useSettings } from '../settings';
import { TERM_LINK_STR } from '../term-link-strings';
import {
  buildLinkMenuItems,
  buildTerminalMenuItems,
  type LinkMenuAction,
  type TerminalMenuAction,
} from '../term-menu';
import { initialTermSearchState, termSearchReducer } from '../term-search';
import { notifyTerminalBus, registerTerminal } from '../terminal-bus';
import { terminalClipboardAction } from '../terminal-clipboard';
import {
  matchConhostCellWidths,
  sizeDiffers,
  windowsPtyOptions,
  writeReplay,
} from '../terminal-conpty';
import { CONTEXT_WINDOW_LINES, inferContextRoot } from '../terminal-context-root';
import { formatPathForTerminal, TERMINAL_PATH_MIME } from '../terminal-drop';
import { terminalGpu } from '../terminal-gpu';
import { lastPick, notePick } from '../terminal-link-picks';
import {
  detectCommitTokens,
  detectPathTokens,
  detectUrlTokens,
  filterCommitTokensByPathSpans,
  MAX_PATH_TOKENS,
} from '../terminal-links';
import { buildLogicalLine, offsetAtCell, toBufferRange } from '../terminal-logical-line';
import {
  capTokenKeys,
  type LinkTarget,
  pathLinksOf,
  pathTokenKey,
  type TokenLine,
} from '../terminal-path-links-at';
import { isViewportAtBottom, shouldHandleWheelLocally, wheelScrollLines } from '../terminal-scroll';
import { attachScrollDiagnostics } from '../terminal-scroll-diagnostics';
import { createTerminalTokenCache } from '../terminal-token-cache';
import { pushToast } from '../toast-store';
import { buildXtermTheme, monoStack } from '../xterm-theme';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { PathCandidatePicker, type PickerMode } from './path-candidate-picker';
import { detectedLinkRow, type PickerRow, pickerRows } from './path-candidate-picker-model';
import { disposeTerminal } from './safe-dispose';
import { TermSearchBar } from './term-search-bar';
import { TimerChip } from './timer-chip';

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
// Mirrors PATH_LINK_OPTS in electron/main.ts: the host folds case everywhere but Linux.
const CONTEXT_PATH_OPTS = {
  platform: IS_WINDOWS ? ('win32' as const) : ('posix' as const),
  caseSensitive: !IS_WINDOWS && !IS_MAC,
};

// Upper bound on a path/commit link round-trip to the host. Only guards the case where
// the reply never arrives (session disposed mid-flight) — kept generous so a merely slow
// resolve (large repo, loaded machine) still lands its links rather than falling back to
// plain text; on the rare real timeout, the next repaint re-runs against the cache.
const LINK_RESOLVE_TIMEOUT_MS = 10_000;
const LINK_CACHE_CAPACITY = 2048;
// Spec 2026-10-16-terminal-path-links §5: a found path stays linked this long without a re-ask.
const PATH_LINK_TTL_MS = 30_000;

/** A cached resolution with the roots its candidates' rootIdx index into. */
interface LinkResolution {
  res: TokenResolution;
  roots: ResolveRoot[];
}

type PathLinkReply = Extract<HostToWebview, { type: 'resolvePathTokenResult' }>;

/** A resolved path link: what a click, a right-click or the keyboard path acts on. */
interface PathLinkEntry {
  /** The alt that resolved (row 40), as printed. */
  token: string;
  found: LinkResolution;
  link: LinkTarget;
  /** 0-based buffer row its logical line starts on (the context root reads above it). */
  firstRow: number;
}

interface PickerState {
  at: { x: number; y: number };
  token: string;
  rows: PickerRow[];
  total: number;
  truncated: boolean;
  link: LinkTarget;
  mode: PickerMode;
  /** The keyboard path's list (row 60): one row per link, picking runs that link's click. */
  entries?: PathLinkEntry[];
}

/** The link under the pointer, tracked by the links' own hover/leave (xterm's current link is
 *  private): a middle press is suppressed over any link, and a right-click on a path link adds
 *  its actions. */
type HoveredLink =
  | ({ kind: 'path' } & PathLinkEntry)
  | { kind: 'osc8-file'; uri: string }
  | { kind: 'url' | 'commit' };

// Explorer's icons for the same actions (webview/explorer-menu.tsx).
const LINK_MENU_ICONS: Record<LinkMenuAction, ReactNode> = {
  open: <IconDoc size={14} />,
  showAll: <IconSearch size={14} />,
  copyPath: <IconCopy size={14} />,
  copyRelativePath: <IconCopy size={14} />,
  reveal: <IconExternal size={14} />,
  openAsSession: <IconTerminal size={14} />,
};

interface ReplayState {
  active: boolean;
  resyncDue: boolean;
}

/** Where a terminal link URI may go; `openFile` is the host-confined open. */
function linkUriSinks(openFile: (uri: string) => void): LinkUriSinks {
  return {
    openFile,
    openExternal,
    windowOpen: (uri) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    },
  };
}

function tellHostSize(sent: { current: TermGeometry | null }, sessionId: string, term: Terminal) {
  sent.current = { cols: term.cols, rows: term.rows };
  post({ type: 'term:resize', sessionId, cols: term.cols, rows: term.rows });
}

/** True while a cold replay is queued: the fit is skipped and owed to the replay's end. */
function deferWhileReplaying(r: ReplayState): boolean {
  if (r.active) r.resyncDue = true;
  return r.active;
}

export function TerminalPane({
  sessionId,
  agentId,
  cwd,
  rootsSig,
  visible,
  onOpenFile,
  onRevealFolder,
  onOpenCommitReview,
  onOpenTimedMessages,
  onSearchAllFiles,
  onOpenAsSession,
  openAsSessionHint,
  inputBox,
}: {
  sessionId: string;
  agentId?: string;
  cwd?: string;
  /** rootsSigOf(session): part of the path-link cache scope, so an attach, detach or repo
   *  discovery misses at once. Mirrored into a ref, never an effect dep. */
  rootsSig: string;
  visible: boolean;
  /** Called when a file path link is clicked: absolute path + optional position +
   * this pane's session id, so the doc opens in the session whose terminal was clicked
   * (not the globally-active one — they differ in split view / same-folder sessions). */
  onOpenFile?: (
    path: string,
    line?: number,
    col?: number,
    originSessionId?: string,
    mode?: OpenMode,
  ) => void;
  /** Called when a folder path link is clicked: opens the OS file manager at that path. */
  onRevealFolder?: (path: string) => void;
  /** Called when a host-confirmed commit hash is clicked: opens Review scoped to that commit
   * for this pane's session. The sha is always the host-returned full 40-char oid; `repoRoot` is
   * the terminal's cwd repo (from validateCommitsResult) so Review reads it from there. Spec §3.3. */
  onOpenCommitReview?: (sha: string, sessionId: string, repoRoot?: string) => void;
  /** Open the timed-message dialog for this session — from the chip (§2 "Entry points"). */
  onOpenTimedMessages?: (sessionId: string) => void;
  /** The path picker's "Search all files…": quick open prefilled with the token. */
  onSearchAllFiles?: (query: string) => void;
  /** A path link's "Open as new session": prefills the New session dialog, never launches. */
  onOpenAsSession?: (
    home: string,
    originSessionId: string,
    returnFocus: HTMLElement | null,
  ) => void;
  /** "in <project>", shown beside "Open as new session". */
  openAsSessionHint?: string;
  /** The session agent's input prompt row and prompt echo, when it has an adapter (inputBoxPrompt). */
  inputBox?: InputBoxPrompt;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // While a cold replay is queued its runs own the terminal's size: a fit landing between a run's
  // resize and its bytes would write them at the wrong width. Deferred fits rerun when it ends.
  const replayRef = useRef<ReplayState>({ active: false, resyncDue: false });
  // The size the host's PTY was last given. Any fit that leaves the xterm at another size must
  // tell the host, or the PTY addresses rows the xterm doesn't have (cursor below the prompt).
  const sentSizeRef = useRef<TermGeometry | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const { settings, update } = useSettings();

  const [search, dispatchSearch] = useReducer(termSearchReducer, initialTermSearchState);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pathDragOver, setPathDragOver] = useState(false);
  // Whether the viewport is pinned to the newest output. Mirrored into a ref because the
  // scroll listener fires per scrolled line under a busy agent — only a flip re-renders.
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
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
  const rootsSigRef = useRef(rootsSig);
  rootsSigRef.current = rootsSig;
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const inputBoxRef = useRef(inputBox);
  inputBoxRef.current = inputBox;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onRevealFolderRef = useRef(onRevealFolder);
  onRevealFolderRef.current = onRevealFolder;
  const onOpenCommitReviewRef = useRef(onOpenCommitReview);
  onOpenCommitReviewRef.current = onOpenCommitReview;
  const onOpenAsSessionRef = useRef(onOpenAsSession);
  onOpenAsSessionRef.current = onOpenAsSession;
  const openAsSessionHintRef = useRef(openAsSessionHint);
  openAsSessionHintRef.current = openAsSessionHint;
  const hoveredLinkRef = useRef<HoveredLink | null>(null);

  // The ranked picker of an ambiguous path link (spec 2026-10-16-terminal-path-links §8). One
  // at a time: a second click replaces it.
  const [picker, setPicker] = useState<PickerState | null>(null);
  // Set by the init effect, which owns the path cache: a stale target's entry is evicted.
  const evictPathRef = useRef<(key: string, scope: string) => void>(() => {});
  // Set by the init effect, which owns the path cache: the resolved path links on the given
  // buffer rows, newest first, or the one under `cell` on that row (row 60's keyboard path).
  // `truncated`: more distinct tokens were on those rows than one resolve takes.
  const pathLinksAtRef = useRef<
    (
      rows: readonly number[],
      cell?: { col: number },
    ) => Promise<{ entries: PathLinkEntry[]; truncated: boolean }>
  >(async () => ({ entries: [], truncated: false }));
  // Set by the init effect, which owns the reply subscription: one uncached host resolve of a
  // link URI (plan T8.3). Null without the bridge or on a timeout.
  const requestOnceRef = useRef<(uri: string) => Promise<PathLinkReply | null>>(async () => null);

  /** Re-checks existence before opening (spec row 55): a stale target toasts, drops its cache
   *  entry and opens nothing. The probed kind, not `cand.isDir`, decides file vs folder — a UNC
   *  candidate's isDir is only a guess for the icon. */
  const openCandidate = useCallback(
    async (cand: PathCandidate, link: LinkTarget, mode?: OpenMode) => {
      const kind = await probePathKind(cand.absPath);
      if (kind === null) {
        pushToast({
          message: TERM_LINK_STR.noLongerExists(cand.absPath.split('/').pop() ?? cand.absPath),
          variant: 'info',
        });
        evictPathRef.current(link.key, link.scope);
        return null;
      }
      if (kind === 'dir') onRevealFolderRef.current?.(cand.absPath);
      else onOpenFileRef.current?.(cand.absPath, link.line, link.col, sessionId, mode);
      return kind;
    },
    [sessionId],
  );
  const openCandidateRef = useRef(openCandidate);
  openCandidateRef.current = openCandidate;

  /** A file-class link URI opens only what the host decoded, confined and found — its
   *  realpath — never a path the renderer derived from the URI (plan T8.3). A refused target
   *  opens nothing. */
  const openUriTarget = async (uri: string, mode?: OpenMode): Promise<void> => {
    const reply = await requestOnceRef.current(uri);
    const res = reply?.results[0];
    const cand = res?.candidates[0];
    if (!res || !cand) return;
    await openCandidateRef.current(
      cand,
      { key: res.key, scope: '', line: res.line, col: res.col },
      mode,
    );
  };
  const openUriTargetRef = useRef(openUriTarget);
  openUriTargetRef.current = openUriTarget;

  /** A path link's click (spec §2.3 step 5), ranked now so the last pick is current: one target
   *  opens, an ambiguous one opens the picker at `at`. */
  const activatePathLink = (
    entry: PathLinkEntry,
    at: { x: number; y: number },
    mode?: OpenMode,
  ) => {
    const { found, link, token } = entry;
    const ranked = rankCandidates(found.res.candidates, {
      roots: found.roots,
      lastPickRepoRoot: lastPick(sessionId),
    });
    const click = chooseClickAction(ranked);
    if (click.kind === 'open') {
      void openCandidateRef.current(click.cand, link, mode);
    } else if (click.kind === 'pick') {
      setPicker({
        at,
        token,
        rows: pickerRows(ranked, found.roots, contextRootFor(entry.firstRow, found.roots)),
        total: found.res.total,
        truncated: found.res.truncated,
        link,
        mode: { kind: 'open' },
      });
    }
  };
  const activatePathLinkRef = useRef(activatePathLink);
  activatePathLinkRef.current = activatePathLink;

  /** The root the lines above a link point at (spec §3.3 context root), read at click time so
   *  output printed since the link was provided counts. */
  const contextRootFor = (firstRow: number, roots: readonly ResolveRoot[]): number | undefined => {
    const term = termRef.current;
    if (!term) return undefined;
    const above: string[] = [];
    let y = firstRow - 1;
    while (y >= 0 && above.length < CONTEXT_WINDOW_LINES) {
      const ll = buildLogicalLine(term.buffer.active, y, term.cols);
      if (!ll) {
        y--;
        continue;
      }
      above.push(ll.text);
      y = ll.firstRow - 1;
    }
    const cwd = (cwdRef.current ?? '').replace(/\\/g, '/');
    return inferContextRoot(above, roots, { cwd, ...CONTEXT_PATH_OPTS });
  };
  const contextRootForRef = useRef(contextRootFor);
  contextRootForRef.current = contextRootFor;

  const closePicker = useCallback(() => {
    setPicker(null);
    termRef.current?.focus();
  }, []);

  /** One link action on one candidate (spec 2026-10-16-terminal-path-links §3.4). Open and Open
   *  as new session re-check existence first, as a click does. */
  const runLinkAction = async (
    action: LinkMenuAction,
    cand: PathCandidate,
    link: LinkTarget,
  ): Promise<void> => {
    const term = termRef.current;
    if (action === 'copyPath') {
      void navigator.clipboard?.writeText(cand.absPath);
    } else if (action === 'copyRelativePath') {
      void navigator.clipboard?.writeText(cand.relToRepo);
    } else if (action === 'reveal') {
      onRevealFolderRef.current?.(cand.absPath);
    } else if (action === 'open' || action === 'showAll') {
      const kind = await openCandidate(cand, link);
      if (kind !== 'file') term?.focus();
      return;
    } else if (action === 'openAsSession') {
      const kind = await probePathKind(cand.absPath);
      if (kind === null) {
        pushToast({
          message: TERM_LINK_STR.noLongerExists(cand.absPath.split('/').pop() ?? cand.absPath),
          variant: 'info',
        });
        evictPathRef.current(link.key, link.scope);
        term?.focus();
        return;
      }
      // A folder opens itself; a file opens its repo (spec Decisions "File → Open as new session").
      onOpenAsSessionRef.current?.(
        kind === 'dir' ? cand.absPath : cand.repoRoot,
        sessionId,
        term?.textarea ?? null,
      );
      return;
    }
    term?.focus();
  };

  const pickRow = async (row: PickerRow, how: 'foreground' | 'background', from: PickerState) => {
    const { link, mode, entries } = from;
    setPicker(null);
    if (entries) {
      const entry = entries[from.rows.indexOf(row)];
      if (entry) activatePathLink(entry, from.at, how === 'background' ? 'background' : undefined);
      return;
    }
    if (mode.kind === 'action') {
      notePick(sessionId, row.cand.repoRoot);
      await runLinkAction(mode.action, row.cand, link);
      return;
    }
    const kind = await openCandidate(
      row.cand,
      link,
      how === 'background' ? 'background' : undefined,
    );
    if (kind !== null) notePick(sessionId, row.cand.repoRoot);
    // An opened file takes focus in its editor; anything else hands it back to the terminal.
    if (kind !== 'file' || how === 'background') termRef.current?.focus();
  };

  useEffect(() => {
    if (!visible) setPicker(null);
  }, [visible]);

  useEffect(() => {
    if (!ref.current) return;
    const suppressLinkMiddleDown = (e: MouseEvent) => {
      if (isMiddleButton(e) && hoveredLinkRef.current !== null) e.preventDefault();
    };
    let term: Terminal;
    let fit: FitAddon;
    let search: SearchAddon;
    let unregisterGpu: (() => void) | null = null;
    const reportGpuLoss = () => terminalGpu.reportLoss(term);
    try {
      term = new Terminal({
        fontFamily: monoStack(fontMonoRef.current),
        fontSize: termFontRef.current,
        // Must be 1.0 so box-drawing characters (│ ┌ └) connect vertically; extra
        // leading breaks them into dashes.
        lineHeight: 1.0,
        cursorBlink: true,
        // xterm's default ring is 1000 lines — roughly eight seconds of a working agent.
        // Once the ring is full, a scrolled-up reader is pushed AWAY from the bottom on
        // every trimmed line (see the follow-state listener below), so a small ring turns
        // ordinary reading into the runaway-scroll bug. Bigger ring, rarer trimming.
        scrollback: 10000,
        // Canvas stays transparent (R4.3b); the configurable surface (colour × opacity)
        // lives on the `.termwrap` container via `--term-surface`, so opacity changes
        // cascade through CSS without re-theming. The re-theme effect below still
        // re-applies foreground/ANSI colours on app-theme/font changes.
        theme: buildXtermTheme(),
        allowProposedApi: true,
        ...windowsPtyOptions(windowsPty),
        // Transparent so the container surface and animated app backdrop show through.
        allowTransparency: true,
        // OSC 8 hyperlinks — what Claude Code and most modern CLIs emit — are matched by
        // xterm's OWN built-in provider, never by the regex `linkProvider` below, so they
        // need their own handler. Without one xterm falls back to its default: a confirm()
        // reading "WARNING: This link could potentially be dangerous", and then
        // `window.open()` with NO url, which the host's setWindowOpenHandler denies as
        // about:blank — so the warning appeared and the link never opened.
        linkHandler: {
          // OSC 8 file targets (plan T8.3, behind the T8.4 review). Every scheme now reaches
          // activate, where dispatchLinkUri drops all but file and http(s). xterm gives an OSC 8
          // link no decorations hook, so an inert scheme still underlines (T8.4 r1 H5).
          allowNonHttpProtocols: true,
          activate: (event: MouseEvent, uri: string) => {
            const action = terminalLinkMiddleAction(event.button, navigator.platform);
            if (action === 'ignore') return;
            dispatchLinkUri(
              uri,
              linkUriSinks((target) => {
                void openUriTargetRef.current(
                  target,
                  action === 'background' ? 'background' : undefined,
                );
              }),
            );
          },
          hover: (_event: MouseEvent, uri: string) => {
            hoveredLinkRef.current =
              classifyLinkUri(uri) === 'file' ? { kind: 'osc8-file', uri } : { kind: 'url' };
          },
          leave: () => {
            hoveredLinkRef.current = null;
          },
        },
      });
      termRef.current = term;
      // Test observability (opt-in): when a harness has pre-created window.__terms,
      // expose the live terminal so e2e can assert on RENDERED buffer content — not
      // just the term:data byte stream. The scrollback-restore bug shipped precisely
      // because the only check was on bytes-over-IPC, never the resulting buffer.
      // No-op in production (the object is never created there).
      {
        const terms = (window as unknown as { __terms?: Record<string, Terminal> }).__terms;
        if (terms) terms[sessionId] = term;
      }
      fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      matchConhostCellWidths(term);
      // Find-in-terminal (L4). Registered before open so its decorations attach.
      search = new SearchAddon();
      searchRef.current = search;
      term.loadAddon(search);
      term.open(ref.current);
      term.element?.addEventListener('mousedown', suppressLinkMiddleDown, true);
      // `webglcontextlost` doesn't bubble out of xterm's canvas; capture still sees it.
      term.element?.addEventListener('webglcontextlost', reportGpuLoss, true);
      // Restore wheel scrollback scrolling when a TUI enables mouse tracking (NOT Claude
      // Code — it never does; see terminal-scroll.ts): xterm then forwards the wheel to the
      // app and stops scrolling history,
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
      // Last in the try: a throw before it would return from the effect with no cleanup, leaking
      // the terminal's WebGL slot. The renderer draws box/block glyphs to fill the cell (crisper).
      unregisterGpu = terminalGpu.register(term);
    } catch (e) {
      logToHost(`xterm init failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Drive the jump-to-latest affordance. This is NOT cosmetic: once the scrollback ring
    // is full, xterm keeps a scrolled-up reader's text stationary by decrementing ydisp on
    // every trimmed line while ybase stays pinned, so the gap to the bottom grows at the
    // OUTPUT rate. Against a busy agent that outruns any wheel, so the wheel can never
    // reach the bottom — a direct scrollToBottom is the only way back to following.
    const syncFollow = () => {
      const buf = term.buffer.active;
      const atBottom = isViewportAtBottom(buf.viewportY, buf.baseY);
      if (atBottom === followingRef.current) return;
      followingRef.current = atBottom;
      setFollowing(atBottom);
    };
    const onScrollFollow = term.onScroll(syncFollow);
    // The picker is anchored to a buffer cell: any terminal scroll leaves it pointing elsewhere.
    // (A wheel scroll never fires onScroll; the viewport's scroll event closes it via Popover.)
    const onScrollPicker = term.onScroll(() => setPicker(null));
    // TEMPORARY (scroll-lock investigation): records every user scroll attempt and each
    // hidden/shown transition to the host log. Remove with terminal-scroll-diagnostics.ts.
    const detachScrollDiag = ref.current
      ? attachScrollDiagnostics(sessionId, term as never, ref.current)
      : () => {};
    // xterm reports a wheel/scrollbar scroll with suppressScrollEvent, so onScroll fires for
    // new output and for scrollLines() but NEVER for the wheel — watching only onScroll left
    // the control invisible on an idle terminal, the exact moment it is wanted. The viewport's
    // own scroll event is the authoritative signal for that path.
    const viewportEl = ref.current?.querySelector('.xterm-viewport');
    viewportEl?.addEventListener('scroll', syncFollow, { passive: true });

    // Path link provider (D11 + path-links v1). Only with the host bridge present; the preview
    // has no filesystem to resolve against. Tokens on a line are resolved in ONE batched
    // `resolvePathToken` round-trip; the host returns 0/1/N candidate files per token.
    let linkProviderDisposable: { dispose(): void } | null = null;
    let unsubResolve: (() => void) | null = null;
    let unsubValidate: (() => void) | null = null;
    let disposeLinkCaches = () => {};
    if (window.agentDeck) {
      // The host stores under the cwd and roots it resolved against; a lookup under a stale pair
      // simply misses (plan Contracts "Cache").
      const scopeNow = () =>
        `${(cwdRef.current ?? '').replace(/\\/g, '/')}\0${rootsSigRef.current}`;
      const resolveCache = createTerminalTokenCache<LinkResolution>(
        // pathTokenKey joins a token's alts by NUL; no path char is NUL, so the split is exact.
        (batch) =>
          post({
            type: 'resolvePathToken',
            sessionId,
            requestId: batch.id,
            tokens: batch.tokens.map((token) => ({ alts: token.split('\0') })),
          }),
        {
          capacity: LINK_CACHE_CAPACITY,
          timeoutMs: LINK_RESOLVE_TIMEOUT_MS,
          ttlMs: PATH_LINK_TTL_MS,
          // A miss is at most as stale as the host's file index (plan Decisions "cache scope").
          negative: { is: (r) => r.res.candidates.length === 0, ttlMs: FILE_INDEX_TTL_MS },
        },
      );
      const commitCache = createTerminalTokenCache<string | null>(
        (batch) => post({ type: 'validateCommits', sessionId, tokens: batch.tokens }),
        { capacity: LINK_CACHE_CAPACITY, timeoutMs: LINK_RESOLVE_TIMEOUT_MS },
      );
      let commitRepoRoot: string | undefined;
      // Ids count down from -2: the cache's batches count up from 1 and -1 is the host's echo of
      // an unreadable id, so a uri reply can never settle (and be stored by) the path cache.
      let nextOnceId = -2;
      const pendingOnce = new Map<number, (reply: PathLinkReply | null) => void>();
      requestOnceRef.current = (uri) =>
        new Promise((resolve) => {
          const requestId = nextOnceId--;
          const done = (reply: PathLinkReply | null) => {
            clearTimeout(timer);
            pendingOnce.delete(requestId);
            resolve(reply);
          };
          const timer = setTimeout(() => done(null), LINK_RESOLVE_TIMEOUT_MS);
          pendingOnce.set(requestId, done);
          post({
            type: 'resolvePathToken',
            sessionId,
            requestId,
            tokens: [{ alts: [uri], target: 'uri' }],
          });
        });
      disposeLinkCaches = () => {
        resolveCache.dispose();
        commitCache.dispose();
        for (const done of [...pendingOnce.values()]) done(null);
        requestOnceRef.current = async () => null;
        pathLinksAtRef.current = async () => ({ entries: [], truncated: false });
      };
      evictPathRef.current = (key, scope) => resolveCache.evict(key, scope);
      // Folder keys of the roots the last reply resolved against: an fsChanged under one of them
      // may have created a file an earlier miss said was not there.
      let rootKeys: string[] = [];
      unsubResolve = subscribe((msg) => {
        if (msg.type === 'fsChanged') {
          const touched = msg.folders.map(folderKey);
          const covers = touched.some((f) =>
            rootKeys.some((r) => isAncestorOf(r, f) || isAncestorOf(f, r)),
          );
          // Only misses go: a found target that was deleted is caught by the click probe.
          if (covers) resolveCache.evictWhere((v) => v.res.candidates.length === 0);
          return;
        }
        if (msg.type !== 'resolvePathTokenResult' || msg.sessionId !== sessionId) return;
        const once = pendingOnce.get(msg.requestId);
        if (once) {
          once(msg);
          return;
        }
        if (msg.requestId < 0) return;
        rootKeys = msg.roots.map((r) => folderKey(r.abs));
        // An errored entry is not cached; settle still releases its waiter as a miss. Each value
        // carries the roots its rootIdx values index.
        const values = new Map<string, LinkResolution>();
        for (const r of msg.results) if (!r.error) values.set(r.key, { res: r, roots: msg.roots });
        resolveCache.settle(msg.requestId, `${msg.cwd}\0${msg.rootsSig}`, values);
      });
      unsubValidate = subscribe((msg) => {
        if (msg.type !== 'validateCommitsResult' || msg.sessionId !== sessionId) return;
        if (msg.root) commitRepoRoot = msg.root;
        for (const r of msg.results) commitCache.resolve(r.token, r.commit);
      });

      // Only agent output links: the live input box (the user's draft and the CLI's chrome) and
      // prompts echoed into history are the user's own text (spec 2026-10-27-input-box-links).
      // Re-read on every ask: the box moves with the cursor.
      const userRowsNow = () => {
        const buf = term.buffer.active;
        const prompt = inputBoxRef.current;
        const boxTop = inputBoxTop(
          (y) => buf.getLine(y)?.translateToString(true),
          buf.baseY + buf.cursorY,
          { cols: term.cols, rows: term.rows, prompt },
        );
        const cell = buf.getNullCell();
        const rowAt = (y: number): RowView | undefined => {
          const line = buf.getLine(y);
          if (!line) return undefined;
          line.getCell(0, cell);
          return {
            text: line.translateToString(true),
            bg0: cell.isBgDefault() ? '' : `${cell.getBgColorMode()}:${cell.getBgColor()}`,
            dim0: cell.isDim() !== 0,
          };
        };
        return (y: number) =>
          (boxTop !== null && y >= boxTop) || inPromptEcho(rowAt, y, prompt?.echo);
      };
      const linkProvider: ILinkProvider = {
        provideLinks(bufferLineNumber, callback) {
          if (userRowsNow()(bufferLineNumber - 1)) {
            callback(undefined);
            return;
          }
          // Detection runs on the soft-wrapped logical line, so a path split at the wrap is one
          // link; xterm asks per row, and only links touching that row are returned.
          const ll = buildLogicalLine(term.buffer.active, bufferLineNumber - 1, term.cols);
          if (!ll) {
            callback(undefined);
            return;
          }
          const text = ll.text;
          const rangeOf = (s: { start: number; end: number }) => toBufferRange(ll, s.start, s.end);
          const onThisRow = (s: { start: number; end: number }) => {
            const r = rangeOf(s);
            return r.start.y <= bufferLineNumber && bufferLineNumber <= r.end.y;
          };
          // URLs are detected first and given precedence: a path/commit span that overlaps a URL
          // span is dropped (a `file://`/`http(s)` token is a URL, not a path/hash). §precedence.
          const allUrls = detectUrlTokens(text);
          const overlapsUrl = (s: { start: number; end: number }) =>
            allUrls.some((u) => s.start < u.end && u.start < s.end);
          const urlTokens = allUrls.filter(onThisRow);
          const tokens = detectPathTokens(text, cwdRef.current).filter(
            (t) => !overlapsUrl(t) && onThisRow(t),
          );
          const commitTokens = detectCommitTokens(text).filter(
            (t) => !overlapsUrl(t) && onThisRow(t),
          );
          if (tokens.length === 0 && commitTokens.length === 0 && urlTokens.length === 0) {
            callback(undefined);
            return;
          }

          // URL links need no filesystem check, so build them synchronously and never gate them
          // behind the resolve/validate round-trip (or its timeout/error fallback).
          const urlLinks = urlTokens.map((tok) => ({
            range: rangeOf(tok),
            text: text.slice(tok.start, tok.end),
            decorations: { pointerCursor: true, underline: false },
            activate(event: MouseEvent, _text: string) {
              const action = terminalLinkMiddleAction(event.button, navigator.platform);
              if (action === 'ignore') return;
              // A file:// URL is confined like an OSC 8 target, even though it is visible (plan
              // Decisions).
              dispatchLinkUri(
                tok.raw,
                linkUriSinks((uri) => {
                  void openUriTargetRef.current(
                    uri,
                    action === 'background' ? 'background' : undefined,
                  );
                }),
              );
            },
            hover(_event: MouseEvent, _text: string) {
              hoveredLinkRef.current = { kind: 'url' };
              this.decorations = { pointerCursor: true, underline: true };
            },
            leave(_event: MouseEvent, _text: string) {
              hoveredLinkRef.current = null;
              this.decorations = { pointerCursor: true, underline: false };
            },
          }));

          // Only URLs on this row → no host round-trip needed; deliver immediately.
          if (tokens.length === 0 && commitTokens.length === 0) {
            callback(urlLinks.length > 0 ? urlLinks : undefined);
            return;
          }

          const scope = scopeNow();
          // A host reply may never arrive (session disposed mid-flight); without a
          // bound the link callback would never fire and xterm would leave that line's
          // resolution pending forever. Fall back to "no links" on timeout — a later
          // repaint re-runs provideLinks and hits the now-populated cache. The .catch
          // guarantees the callback is invoked even if the .then body throws.
          void withTimeout(
            Promise.all([
              tokens.length > 0
                ? resolveCache.get(tokens.map(pathTokenKey), scope)
                : Promise.resolve(new Map<string, LinkResolution>()),
              commitTokens.length > 0
                ? commitCache.get(commitTokens.map((t) => t.raw))
                : Promise.resolve(new Map<string, string | null>()),
            ]),
            LINK_RESOLVE_TIMEOUT_MS,
            [new Map<string, LinkResolution>(), new Map<string, string | null>()] as [
              Map<string, LinkResolution>,
              Map<string, string | null>,
            ],
          )
            .then(([resMap, commitMap]) => {
              const links = [...urlLinks];
              // Collected from the path links below; commit links then avoid overlapping a path.
              // (No need to seed URL spans here — both path and commit tokens were already filtered
              // against URLs upstream via overlapsUrl.)
              const pathLinks = pathLinksOf([{ firstRow: ll.firstRow, tokens }], resMap, scope);
              const pathSpans = pathLinks.map((p) => p.span);
              for (const { span, ...entry } of pathLinks) {
                links.push({
                  range: rangeOf(span),
                  text: text.slice(span.start, span.end),
                  decorations: { pointerCursor: true, underline: false },
                  activate(event: MouseEvent, _text: string) {
                    const action = terminalLinkMiddleAction(event.button, navigator.platform);
                    if (action === 'ignore') return;
                    activatePathLinkRef.current(
                      entry,
                      { x: event.clientX, y: event.clientY },
                      action === 'background' ? 'background' : undefined,
                    );
                  },
                  hover(_event: MouseEvent, _text: string) {
                    hoveredLinkRef.current = { kind: 'path', ...entry };
                    this.decorations = { pointerCursor: true, underline: true };
                  },
                  leave(_event: MouseEvent, _text: string) {
                    hoveredLinkRef.current = null;
                    this.decorations = { pointerCursor: true, underline: false };
                  },
                });
              }
              // Commit links: path links win on overlap (§3.4); only host-confirmed shas link, and
              // always open via the host-returned full 40-char sha.
              for (const tok of filterCommitTokensByPathSpans(commitTokens, pathSpans)) {
                const full = commitMap.get(tok.raw);
                if (!full) continue;
                links.push({
                  range: rangeOf(tok),
                  text: text.slice(tok.start, tok.end),
                  decorations: { pointerCursor: true, underline: false },
                  activate(event: MouseEvent, _text: string) {
                    if (terminalLinkMiddleAction(event.button, navigator.platform) === 'ignore')
                      return;
                    onOpenCommitReviewRef.current?.(full, sessionId, commitRepoRoot);
                  },
                  hover(_event: MouseEvent, _text: string) {
                    hoveredLinkRef.current = { kind: 'commit' };
                    this.decorations = { pointerCursor: true, underline: true };
                  },
                  leave(_event: MouseEvent, _text: string) {
                    hoveredLinkRef.current = null;
                    this.decorations = { pointerCursor: true, underline: false };
                  },
                });
              }
              callback(links.length > 0 ? links : undefined);
            })
            .catch(() => callback(urlLinks.length > 0 ? urlLinks : undefined));
        },
      };
      linkProviderDisposable = term.registerLinkProvider(linkProvider);
      // The keyboard path (row 60): the same detection and cache as the provider, over chosen rows
      // (or the one token under a cell) instead of the row xterm asks for.
      pathLinksAtRef.current = async (rows, cell) => {
        const buf = term.buffer.active;
        const scope = scopeNow();
        const lines: TokenLine[] = [];
        const isUserRow = userRowsNow();
        for (const y of rows) {
          if (isUserRow(y)) continue;
          const ll = buildLogicalLine(buf, y, term.cols);
          // A logical line spanning several of the rows is read once.
          if (!ll || lines.at(-1)?.firstRow === ll.firstRow) continue;
          const at = cell ? offsetAtCell(ll, y, cell.col) : undefined;
          if (at === null) continue;
          const urls = detectUrlTokens(ll.text);
          const tokens = detectPathTokens(ll.text, cwdRef.current).filter(
            (tok) => !urls.some((u) => tok.start < u.end && u.start < tok.end),
          );
          lines.push({ firstRow: ll.firstRow, tokens, ...(at !== undefined ? { at } : {}) });
        }
        const { keys, truncated } = capTokenKeys(lines, MAX_PATH_TOKENS);
        if (keys.length === 0) return { entries: [], truncated };
        const resMap = await withTimeout(
          resolveCache.get(keys, scope),
          LINK_RESOLVE_TIMEOUT_MS,
          new Map<string, LinkResolution>(),
        );
        const seen = new Set<string>();
        const entries: PathLinkEntry[] = [];
        for (const { span: _span, ...entry } of pathLinksOf(lines, resMap, scope)) {
          if (seen.has(entry.link.key)) continue;
          seen.add(entry.link.key);
          entries.push(entry);
        }
        return { entries, truncated };
      };
      // Test observability (opt-in, mirrors window.__terms): expose the live link provider so
      // e2e can invoke provideLinks/activate directly — clicking xterm's canvas links in the
      // hidden smoke harness is unreliable. No-op in production (the object is never created).
      {
        const reg = (window as unknown as { __termLinkProviders?: Record<string, ILinkProvider> })
          .__termLinkProviders;
        if (reg) reg[sessionId] = linkProvider;
      }
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
        if (msg.replay) {
          replayRef.current.active = true;
          writeReplay(term, msg.data, msg.replay, fitIfVisible, () => {
            const r = replayRef.current;
            r.active = false;
            // A hidden pane fails both fits; the ResizeObserver's sync fits it once it shows.
            if (r.resyncDue) {
              r.resyncDue = false;
              sync();
            } else if (fitIfVisible() && sizeDiffers(sentSizeRef.current, term)) {
              tellHostSize(sentSizeRef, sessionId, term);
            }
            term.scrollToBottom();
          });
        } else writeAndStick(msg.data);
      } else if (msg.type === 'term:exit' && msg.sessionId === sessionId) {
        writeAndStick(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
      }
    });

    // Start the PTY on first real visibility (so it launches at the correct size);
    // resize on every subsequent layout change.
    const sync = () => {
      if (deferWhileReplaying(replayRef.current)) return;
      if (!fitIfVisible()) return;
      if (!started) {
        started = true;
        sentSizeRef.current = { cols: term.cols, rows: term.rows };
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
        tellHostSize(sentSizeRef, sessionId, term);
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
        term.element?.removeEventListener('mousedown', suppressLinkMiddleDown, true);
        term.element?.removeEventListener('webglcontextlost', reportGpuLoss, true);
      } catch {
        /* listener may already be gone */
      }
      try {
        onTitle.dispose();
      } catch {
        /* listener may already be gone */
      }
      try {
        onScrollFollow.dispose();
        onScrollPicker.dispose();
        detachScrollDiag();
        viewportEl?.removeEventListener('scroll', syncFollow);
      } catch {
        /* listener may already be gone */
      }
      try {
        unsub();
      } catch {
        /* no-op */
      }
      try {
        unsubResolve?.();
      } catch {
        /* no-op */
      }
      try {
        unsubValidate?.();
      } catch {
        /* no-op */
      }
      try {
        linkProviderDisposable?.dispose();
      } catch {
        /* no-op */
      }
      ro.disconnect();
      disposeLinkCaches();
      if (started) post({ type: 'term:dispose', sessionId });
      unregisterGpu?.();
      disposeTerminal(term, [fit, search]);
      {
        const terms = (window as unknown as { __terms?: Record<string, Terminal> }).__terms;
        if (terms) delete terms[sessionId];
        const reg = (window as unknown as { __termLinkProviders?: Record<string, ILinkProvider> })
          .__termLinkProviders;
        if (reg) delete reg[sessionId];
      }
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
    if (deferWhileReplaying(replayRef.current)) return;
    try {
      fitRef.current?.fit();
      tellHostSize(sentSizeRef, sessionId, term);
    } catch {
      /* not visible yet */
    }
  }, [sessionId]);

  // Re-theme/re-font the live terminal on theme/mono-font/surface-colour change so its
  // background recolours in place to keep matching the code block (wishlist I1).
  // rAF so SettingsProvider's data-theme attribute is applied before we read CSS vars.
  // biome-ignore lint/correctness/useExhaustiveDependencies: settings.theme is the re-theme trigger — the palette is read off <html>'s CSS vars, not from the value.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const id = requestAnimationFrame(() => {
      term.options.theme = buildXtermTheme(settings.surfaceColor);
      term.options.fontFamily = monoStack(settings.fontMono);
      refitVisibleTerminal();
    });
    return () => cancelAnimationFrame(id);
  }, [settings.theme, settings.fontMono, settings.surfaceColor, refitVisibleTerminal]);

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

  // Register this pane's live terminal so focus requests AND the review-notes handoff can
  // reach exactly this session. termRef is stable, so this registers once per session.
  useEffect(
    () =>
      registerTerminal(sessionId, {
        focus: () => termRef.current?.focus(),
        paste: (text) => termRef.current?.paste(text),
        // Read live: the foreground program owns DECSET 2004, so this flips as the user moves
        // between an agent TUI and a bare shell prompt. See terminal-bus.ts.
        bracketedPaste: () => termRef.current?.modes.bracketedPasteMode === true,
        // Deliberately not copySelection: that clears the selection after reading it, which
        // would make the user's highlight vanish the moment they searched it.
        getSelection: () => termRef.current?.getSelection() ?? '',
        openDetectedLink: () => void openDetectedLinkRef.current(),
      }),
    [sessionId],
  );

  // Bracketed paste is owned by the foreground program, so it flips with no React state behind it
  // — an agent TUI starting or the user dropping back to a bare prompt. onWriteParsed is the only
  // point at which it can have changed (a mode is set by a written escape sequence), and the bus
  // is only nudged on an actual transition, not on every chunk of output.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let last = term.modes.bracketedPasteMode;
    const sub = term.onWriteParsed(() => {
      const now = term.modes.bracketedPasteMode;
      if (now === last) return;
      last = now;
      notifyTerminalBus();
    });
    return () => sub.dispose();
  }, []);

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

  const terminalMenuItems = (term: Terminal): MenuItem[] => {
    const canPaste = typeof navigator.clipboard?.readText === 'function';
    return buildTerminalMenuItems({ hasSelection: term.hasSelection(), canPaste }).map((s) => ({
      label: s.label,
      icon: MENU_ICONS[s.iconKey],
      disabled: s.disabled,
      separatorBefore: s.separatorBefore,
      onClick: () => runMenuAction(s.action),
    }));
  };

  /** Viewport point under the bottom-left of a cell of the visible screen. */
  const cellPoint = (term: Terminal, col: number, viewRow: number) => {
    const r = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!r || term.cols === 0 || term.rows === 0) return { x: 0, y: 0 };
    return {
      x: r.left + (col * r.width) / term.cols,
      y: r.top + ((viewRow + 1) * r.height) / term.rows,
    };
  };

  /** The cursor cell: the keyboard's stand-in for the pointer. */
  const cursorCell = (term: Terminal) => {
    const buf = term.buffer.active;
    const row = buf.baseY + buf.cursorY;
    return { row, col: buf.cursorX, at: cellPoint(term, buf.cursorX, row - buf.viewportY) };
  };

  /** "Terminal: Open Detected Link…" (row 60): a picker over the path links on screen, one row
   *  per link; picking one runs its click. */
  const openDetectedLink = async () => {
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const rows = Array.from({ length: term.rows }, (_, i) => buf.viewportY + i);
    const { entries, truncated } = await pathLinksAtRef.current(rows);
    if (entries.length === 0) {
      pushToast({ message: TERM_LINK_STR.noLinksOnScreen, variant: 'info' });
      return;
    }
    const pickerEntries = entries.map((entry) => {
      const [top] = rankCandidates(entry.found.res.candidates, {
        roots: entry.found.roots,
        lastPickRepoRoot: lastPick(sessionId),
      });
      // Two links can share a top candidate; the link's own key is unique.
      const row = detectedLinkRow(entry.link.key, entry.token, top, entry.found.roots);
      return { row, entry };
    });
    setPicker({
      at: cursorCell(term).at,
      token: TERM_LINK_STR.linksOnScreen,
      rows: pickerEntries.map((p) => p.row),
      total: entries.length,
      truncated,
      link: entries[0].link,
      mode: { kind: 'open' },
      entries: pickerEntries.map((p) => p.entry),
    });
  };
  const openDetectedLinkRef = useRef(openDetectedLink);
  openDetectedLinkRef.current = openDetectedLink;

  /** Shift+F10 / the ContextMenu key: the link menu for the link under the cursor cell, else the
   *  terminal's own, keyboard-highlighted. */
  const openKeyboardMenu = async () => {
    const term = termRef.current;
    if (!term) return;
    const cell = cursorCell(term);
    const termItems = terminalMenuItems(term);
    const {
      entries: [entry],
    } = await pathLinksAtRef.current([cell.row], { col: cell.col });
    if (!entry) {
      setMenu({ ...cell.at, items: termItems, keyboard: true });
      return;
    }
    showLinkMenu(cell.at, termItems, entry, true);
  };

  const openContextMenu = (e: React.MouseEvent) => {
    const term = termRef.current;
    if (!term) return;
    // On Windows the right button can extend xterm's selection; preventDefault stops the
    // OS menu and xterm's default so only our menu opens.
    e.preventDefault();
    const termItems = terminalMenuItems(term);
    const at = { x: e.clientX, y: e.clientY };
    const hovered = hoveredLinkRef.current;
    if (hovered?.kind === 'osc8-file') {
      // Resolved by the host exactly as a click is (uncached, confined); a refused target gets
      // the terminal's own menu.
      const { uri } = hovered;
      void requestOnceRef.current(uri).then((reply) => {
        const res = reply?.results[0];
        if (!reply || !res || res.candidates.length === 0) {
          setMenu({ ...at, items: termItems });
          return;
        }
        showLinkMenu(at, termItems, {
          found: { res, roots: reply.roots },
          link: { key: res.key, scope: '', line: res.line, col: res.col },
          token: uri,
        });
      });
      return;
    }
    if (hovered?.kind !== 'path') {
      setMenu({ ...at, items: termItems });
      return;
    }
    showLinkMenu(at, termItems, hovered);
  };

  /** A link's actions lead, then the terminal's own (spec §3.4). An OSC 8 target has no
   *  `firstRow`, so no context root. */
  const showLinkMenu = (
    at: { x: number; y: number },
    termItems: MenuItem[],
    {
      found,
      link,
      token,
      firstRow,
    }: { found: LinkResolution; link: LinkTarget; token: string; firstRow?: number },
    keyboard = false,
  ) => {
    const ranked = rankCandidates(found.res.candidates, {
      roots: found.roots,
      lastPickRepoRoot: lastPick(sessionId),
    });
    const click = chooseClickAction(ranked);
    const single = click.kind === 'open' ? click.cand : null;
    const openPicker = (mode: PickerMode) =>
      setPicker({
        at,
        token,
        rows: pickerRows(
          ranked,
          found.roots,
          firstRow === undefined ? undefined : contextRootFor(firstRow, found.roots),
        ),
        total: found.res.total,
        truncated: found.res.truncated,
        link,
        mode,
      });
    const linkItems: MenuItem[] = buildLinkMenuItems({
      target: single ? (single.isDir ? 'dir' : 'file') : null,
      matchCount: found.res.total,
      openAsSessionHint: openAsSessionHintRef.current,
    }).map((spec) => ({
      label: spec.label,
      icon: LINK_MENU_ICONS[spec.id],
      separatorBefore: spec.separatorBefore,
      ...(spec.hint !== undefined ? { hint: spec.hint } : {}),
      onClick: () => {
        if (spec.id === 'showAll') openPicker({ kind: 'open' });
        else if (single) void runLinkAction(spec.id, single, link);
        else openPicker({ kind: 'action', action: spec.id });
      },
    }));
    const [firstTerm, ...restTerm] = termItems;
    setMenu({
      ...at,
      keyboard,
      items: [
        ...linkItems,
        ...(firstTerm ? [{ ...firstTerm, separatorBefore: true }] : []),
        ...restTerm,
      ],
    });
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
          if (e.key === 'ContextMenu' || (e.shiftKey && !mod && !e.altKey && e.key === 'F10')) {
            e.preventDefault();
            e.stopPropagation();
            void openKeyboardMenu();
            return;
          }
          // Shift excluded for the same reason as review-keymap: Mod+Shift+F is the app's
          // global search, seeded from this terminal's selection. Leaving it to the window
          // capture handler's ordering to win would be an implicit dependency.
          if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            e.stopPropagation();
            dispatchSearch({ type: 'open' });
          }
        }}
      />
      {!following && (
        <button
          type="button"
          className="term-follow"
          title="Jump to the newest output and resume following"
          // Deliberately NOT a keystroke: the End/typing workaround only works because
          // xterm's scrollOnUserInput fires, and it also types into the running agent.
          onClick={() => {
            termRef.current?.scrollToBottom();
            focusTerminal();
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M8 2v10M4 8.5l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Jump to latest
        </button>
      )}
      {search.open && (
        <TermSearchBar
          query={search.query}
          onQueryChange={(q) => dispatchSearch({ type: 'setQuery', query: q })}
          onNext={() => dispatchSearch({ type: 'next' })}
          onPrev={() => dispatchSearch({ type: 'prev' })}
          onClose={closeSearch}
        />
      )}
      {onOpenTimedMessages && (
        <TimerChip
          sessionId={sessionId}
          visible={visible}
          // The find bar owns the top-right corner while it is open (§4).
          stacked={search.open}
          onOpen={() => onOpenTimedMessages(sessionId)}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {picker && (
        <PathCandidatePicker
          at={picker.at}
          token={picker.token}
          rows={picker.rows}
          total={picker.total}
          truncated={picker.truncated}
          list={picker.entries ? 'links' : 'files'}
          mode={picker.mode}
          onPick={(row, how) => void pickRow(row, how, picker)}
          // Open Detected Link lists links, not one token's matches: nothing to search for.
          onSearchAll={
            picker.entries
              ? undefined
              : (query) => {
                  setPicker(null);
                  onSearchAllFiles?.(query);
                }
          }
          onClose={closePicker}
        />
      )}
    </div>
  );
}
