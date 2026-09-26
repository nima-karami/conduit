/**
 * VS Code-style breadcrumb bar (E3). Path segments (relative to the session cwd) reveal
 * sibling files/dirs; for TS/JS, cursor-driven symbol segments from the TS worker's nav
 * tree are appended. Symbol segments load async (no error if the worker isn't ready).
 */
import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import {
  Fragment,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { activeCwd } from '../../src/active-cwd';
import type { NavTreeNode, SymbolChainItem } from '../../src/breadcrumbs';
import { breadcrumbPathSegments, enclosingSymbolChain } from '../../src/breadcrumbs';
import type { DirEntryDTO } from '../../src/protocol';
import type { Session } from '../../src/types';
import { post, subscribe } from '../bridge';
import type { OpenMode } from '../docs';
import { IconChevron } from '../icons';
import { lspStateForKey, subscribeLspStatus, useLspLanguages, useLspStatuses } from '../lsp-status';
import {
  currentVersion,
  lspRequest,
  requestTrust,
  serverKeyForDoc,
  subscribeLspDocSent,
} from '../lsp-sync';
import { restrictedText } from '../nav-outcome';
import { fileUri, openDefinitionFile, subscribeCursor } from '../project-index';
import { ContextMenu, type MenuState } from './context-menu';

/** Language IDs that support symbol segments via the TS worker. */
const TS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

/** A server-language refetch waits for edits to settle: symbols are never fetched per keystroke
 *  or per cursor move (spec 2026-09-22-language-server-go §4 "Breadcrumbs while not ready"). */
const LSP_SYMBOLS_SETTLE_MS = 500;
let symbolsSeq = 0;

interface BreadcrumbBarProps {
  /** Absolute path of the currently open file. */
  filePath: string;
  /** Language id of the file (from FileContentDTO). */
  language: string;
  /** The active session — used to derive rootCwd via activeCwd. */
  activeSession: Session | undefined;
  /** Open a file in the editor (from app.tsx openFile). */
  onOpenFile: (path: string, mode?: OpenMode) => void;
}

/** Pending dropdown context — tracks a requested dropdown that hasn't received dir data yet. */
interface PendingDropdown {
  dirPath: string;
  rect: DOMRect;
}

export function BreadcrumbBar({
  filePath,
  language,
  activeSession,
  onOpenFile,
}: BreadcrumbBarProps) {
  const rootCwd = activeSession ? activeCwd(activeSession) : '';
  const pathSegments = breadcrumbPathSegments(filePath, rootCwd);
  const isTs = TS_LANGS.has(language);
  const lspLanguages = useLspLanguages();
  const serverInfo = lspLanguages.find((l) => l.languageId === language) ?? null;
  const isServer = serverInfo !== null;
  useLspStatuses();
  const restricted = isServer && lspStateForKey(serverKeyForDoc(filePath)) === 'restricted';
  const lastOffsetRef = useRef<{ path: string; offset: number } | null>(null);

  // Navigation tree for the current file (async, best-effort).
  const navTreeRef = useRef<NavTreeNode | null>(null);
  // Track the path the navTree was built for — discard stale results.
  const navTreePathRef = useRef('');
  // Keep the current filePath in a ref for use in async callbacks.
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  // Cursor-driven symbol chain (empty for non-TS files or before tree arrives).
  const [symbolChain, setSymbolChain] = useState<SymbolChainItem[]>([]);

  // Dropdown menu state (path AND symbol segments share one ContextMenu).
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Directory entries cache, keyed by absolute dirPath.
  const [dirCache, setDirCache] = useState<Map<string, DirEntryDTO[]>>(new Map());

  // Pending dropdown — a segment was clicked but we're still waiting for the dir listing.
  const pendingRef = useRef<PendingDropdown | null>(null);

  const fetchNavTree = useCallback(
    async (path: string) => {
      if (!TS_LANGS.has(language)) {
        navTreeRef.current = null;
        navTreePathRef.current = '';
        setSymbolChain([]);
        return;
      }
      try {
        const uri = fileUri(path);
        const getWorker = await monacoTs.getTypeScriptWorker();
        const worker = await getWorker(uri);
        const tree = await worker.getNavigationTree(uri.toString());
        if (filePathRef.current === path) {
          navTreeRef.current = (tree as NavTreeNode) ?? null;
          navTreePathRef.current = path;
        }
      } catch {
        // Worker not ready / non-TS — no symbols, no error surface.
        if (filePathRef.current === path) {
          navTreeRef.current = null;
          navTreePathRef.current = '';
        }
      }
    },
    [language],
  );

  useEffect(() => {
    navTreeRef.current = null;
    navTreePathRef.current = '';
    setSymbolChain([]);
    void fetchNavTree(filePath);
  }, [filePath, fetchNavTree]);

  useEffect(() => {
    return subscribeCursor((e) => {
      if (e.path !== filePathRef.current) return;
      lastOffsetRef.current = { path: e.path, offset: e.offset };
      // Nav tree not ready for this file yet — re-fetch, then a later cursor event recomputes.
      // A server language never refetches here: its tree arrives on its own triggers below.
      if (!navTreeRef.current || navTreePathRef.current !== e.path) {
        if (!isServer) void fetchNavTree(e.path);
        return;
      }
      setSymbolChain(enclosingSymbolChain(navTreeRef.current, e.offset));
    });
  }, [fetchNavTree, isServer]);

  // Server-language symbols: on open/path change, when this doc's server turns ready, and once
  // edits have settled. A reply for a version the tab has since moved past is dropped.
  useEffect(() => {
    if (!isServer) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastState = lspStateForKey(serverKeyForDoc(filePath));
    const fetchSymbols = async () => {
      const version = currentVersion(filePath);
      if (version === null) return;
      const reply = await lspRequest(
        filePath,
        'documentSymbol',
        { line: 0, character: 0 },
        `symbols-${++symbolsSeq}`,
      );
      if (reply.kind !== 'symbols' || filePathRef.current !== filePath) return;
      if (currentVersion(filePath) !== version) return;
      navTreeRef.current = reply.tree;
      navTreePathRef.current = filePath;
      const at = lastOffsetRef.current;
      if (at?.path === filePath) setSymbolChain(enclosingSymbolChain(reply.tree, at.offset));
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fetchSymbols(), LSP_SYMBOLS_SETTLE_MS);
    };
    void fetchSymbols();
    const offSent = subscribeLspDocSent((p) => {
      if (p === filePath) schedule();
    });
    const offStatus = subscribeLspStatus(() => {
      const state = lspStateForKey(serverKeyForDoc(filePath));
      if (state === 'ready' && lastState !== 'ready') void fetchSymbols();
      lastState = state;
    });
    return () => {
      if (timer) clearTimeout(timer);
      offSent();
      offStatus();
    };
  }, [filePath, isServer]);

  const openEntriesDropdown = useCallback(
    (entries: DirEntryDTO[], dirPath: string, rect: DOMRect) => {
      const items = entries.map((entry) => {
        const entryPath = `${dirPath.replace(/\/$/, '')}/${entry.name}`;
        return {
          label: entry.name,
          ...(entry.kind === 'file'
            ? { onMiddleClick: () => onOpenFile(entryPath, 'background') }
            : {}),
          onClick: () => {
            pendingRef.current = null;
            if (entry.kind === 'file') {
              onOpenFile(entryPath);
            } else {
              post({ type: 'readDir', path: entryPath });
            }
          },
        };
      });
      setMenu({
        x: rect.left,
        y: rect.bottom + 2,
        items,
      });
    },
    [onOpenFile],
  );

  // In a ref so the once-on-mount subscribe effect calls the latest openEntriesDropdown
  // without it becoming a dependency.
  const openEntriesDropdownRef = useRef(openEntriesDropdown);
  openEntriesDropdownRef.current = openEntriesDropdown;

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'dirEntries') return;
      setDirCache((prev) => new Map(prev).set(msg.path, msg.entries));
      // Open a pending dropdown now that its listing arrived.
      const pending = pendingRef.current;
      if (pending && pending.dirPath === msg.path && msg.entries.length > 0) {
        openEntriesDropdownRef.current(msg.entries, msg.path, pending.rect);
      }
    });
  }, []);

  const handlePathSegmentClick = useCallback(
    (dirPath: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const cached = dirCache.get(dirPath);
      if (cached && cached.length > 0) {
        openEntriesDropdown(cached, dirPath, rect);
      } else {
        // Store pending so the dir-listing subscription opens it on arrival.
        pendingRef.current = { dirPath, rect };
        post({ type: 'readDir', path: dirPath });
      }
    },
    [dirCache, openEntriesDropdown],
  );

  const handleSymbolSegmentClick = useCallback(
    (item: SymbolChainItem, e: React.MouseEvent) => {
      e.stopPropagation();
      if (item.siblings.length === 0) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const items = item.siblings.map((sib) => ({
        label: `${kindGlyph(sib.kind)} ${sib.text}`,
        onClick: () => {
          const model = monaco.editor.getModel(fileUri(filePath));
          if (model) {
            const pos = model.getPositionAt(sib.start);
            // The app's opener stages the reveal → CodeViewer's subscribeReveal centers it.
            openDefinitionFile(filePath, { line: pos.lineNumber, column: pos.column });
          }
        },
      }));
      setMenu({
        x: rect.left,
        y: rect.bottom + 2,
        items,
      });
    },
    [filePath],
  );

  const showSymbols = isTs || isServer;
  const barRef = useRef<HTMLDivElement>(null);
  const contentKey = [
    filePath,
    restricted && serverInfo ? serverInfo.displayName : '',
    ...(showSymbols ? symbolChain.map((s) => `${s.kind} ${s.text}`) : []),
  ].join('\n');
  const collapsed = useCollapsedAncestors(barRef, contentKey, pathSegments.length - 1);

  if (pathSegments.length === 0) return null;

  return (
    <div ref={barRef} className="breadcrumb-bar" aria-label="Breadcrumb navigation">
      {collapsed > 0 && (
        <span
          className="breadcrumb-bar__seg breadcrumb-bar__seg--more"
          title={pathSegments
            .slice(0, collapsed)
            .map((s) => s.name)
            .join('/')}
        >
          …
        </span>
      )}
      {pathSegments.map((seg, i) => {
        if (i < collapsed) return null;
        // Ancestor dirs yield width first; the file name keeps it longest (styles.css).
        const isFile = i === pathSegments.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are ordered path parts; stable by position
          <Fragment key={`path-${i}`}>
            {i > 0 && <Sep />}
            <button
              type="button"
              className={`breadcrumb-bar__seg ${isFile ? 'breadcrumb-bar__seg--file' : 'breadcrumb-bar__seg--dir'}`}
              title={isFile ? seg.name : `Show siblings in ${seg.dirPath}`}
              onClick={(e) => handlePathSegmentClick(seg.dirPath, e)}
            >
              {seg.name}
            </button>
          </Fragment>
        );
      })}

      {restricted && serverInfo && (
        <>
          <Sep />
          <button
            type="button"
            className="breadcrumb-bar__seg breadcrumb-bar__seg--restricted"
            title={restrictedText(serverInfo.displayName)}
            onClick={() => requestTrust(filePath, language)}
          >
            Restricted Mode
          </button>
        </>
      )}

      {showSymbols &&
        symbolChain.map((sym, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: symbol chain is ordered outermost→innermost; stable by position
          <Fragment key={`sym-${i}`}>
            <Sep />
            <button
              type="button"
              className="breadcrumb-bar__seg breadcrumb-bar__seg--symbol"
              title={`Symbol: ${sym.kind} ${sym.text}`}
              onClick={(e) => handleSymbolSegmentClick(sym, e)}
            >
              <span
                className={`breadcrumb-bar__kind breadcrumb-bar__kind--${sym.kind}`}
                aria-hidden
              >
                {kindGlyph(sym.kind)}
              </span>
              {sym.text}
            </button>
          </Fragment>
        ))}

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => {
            setMenu(null);
            pendingRef.current = null;
          }}
        />
      )}
    </div>
  );
}

/**
 * How many leading ancestor dirs to fold into one "…" segment: one more each time the file
 * name is losing text, or the bar has spilled off its start (every segment at its CSS floor,
 * justify-content: flex-end), which would slice the outermost segment mid-glyph. Folding whole
 * segments keeps what is shown legible and gives the width to the file name. The start spill
 * is not scrollable, so scrollWidth cannot see it — the first child's position is measured.
 * Folding only ever grows, so it is re-derived from zero whenever the bar width or anything it
 * lays out changes (`contentKey`: the path, the Restricted Mode segment, the symbol chain) —
 * otherwise content that shrinks would leave dirs folded that now fit.
 */
function useCollapsedAncestors(
  barRef: RefObject<HTMLDivElement | null>,
  contentKey: string,
  dirCount: number,
): number {
  const [collapsed, setCollapsed] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey is the trigger — new content starts from zero
  useLayoutEffect(() => setCollapsed(0), [contentKey]);
  const mounted = dirCount >= 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` is the trigger — the bar renders nothing for an empty path, so the ref only fills once there is one
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    let width = bar.clientWidth;
    const ro = new ResizeObserver(() => {
      if (bar.clientWidth === width) return;
      width = bar.clientWidth;
      setCollapsed(0);
    });
    ro.observe(bar);
    return () => ro.disconnect();
  }, [barRef, mounted]);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const first = bar?.firstElementChild;
    if (!bar || !first || collapsed >= dirCount) return;
    const file = bar.querySelector('.breadcrumb-bar__seg--file');
    const fileCut = !!file && file.scrollWidth > file.clientWidth;
    const inner =
      bar.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(bar).paddingLeft);
    if (fileCut || first.getBoundingClientRect().left < inner - 0.5) setCollapsed(collapsed + 1);
  });
  return collapsed;
}

function Sep() {
  return (
    <span className="breadcrumb-bar__sep" aria-hidden>
      <IconChevron size={11} />
    </span>
  );
}

/** Short glyph hinting at the symbol kind. */
function kindGlyph(kind: string): string {
  switch (kind) {
    case 'class':
    case 'local class':
      return 'C';
    case 'interface':
      return 'I';
    case 'function':
    case 'local function':
      return 'ƒ';
    case 'method':
      return 'm';
    case 'property':
    case 'getter':
    case 'setter':
      return 'p';
    case 'variable':
    case 'let':
    case 'const':
    case 'local var':
      return 'v';
    case 'enum':
    case 'enum member':
      return 'E';
    case 'type':
    case 'type parameter':
      return 'T';
    case 'alias':
      return 'A';
    default:
      return '·';
  }
}
