/**
 * VS Code-style breadcrumb bar (E3).
 *
 * Shows the active file's path relative to the session's cwd, with each segment
 * clickable to reveal sibling files/dirs. For TS/JS files, also appends symbol
 * segments derived from the TS worker's navigation tree, reflecting the cursor
 * position and each listing its siblings.
 *
 * Renders only when a file doc is active (not terminal/review). Path segments
 * appear immediately; symbol segments load async (no error if worker isn't ready).
 */
import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { activeCwd } from '../../src/active-cwd';
import type { NavTreeNode, SymbolChainItem } from '../../src/breadcrumbs';
import { breadcrumbPathSegments, enclosingSymbolChain } from '../../src/breadcrumbs';
import type { DirEntryDTO } from '../../src/protocol';
import type { Session } from '../../src/types';
import { post, subscribe } from '../bridge';
import { IconChevron } from '../icons';
import { fileUri, openDefinitionFile, setReveal, subscribeCursor } from '../project-index';
import { ContextMenu, type MenuState } from './context-menu';

/** Language IDs that support symbol segments via the TS worker. */
const TS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

interface BreadcrumbBarProps {
  /** Absolute path of the currently open file. */
  filePath: string;
  /** Language id of the file (from FileContentDTO). */
  language: string;
  /** The active session — used to derive rootCwd via activeCwd. */
  activeSession: Session | undefined;
  /** Open a file in the editor (from app.tsx openFile). */
  onOpenFile: (path: string) => void;
}

/** Pending dropdown context — tracks a requested dropdown that hasn't received dir data yet. */
interface PendingDropdown {
  dirPath: string;
  rect: DOMRect;
}

/**
 * The breadcrumb bar. Sits between the tab bar and the editor content area.
 */
export function BreadcrumbBar({
  filePath,
  language,
  activeSession,
  onOpenFile,
}: BreadcrumbBarProps) {
  const rootCwd = activeSession ? activeCwd(activeSession) : '';
  const pathSegments = breadcrumbPathSegments(filePath, rootCwd);
  const isTs = TS_LANGS.has(language);

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

  // ── Navigation tree fetch ────────────────────────────────────────────────

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
        // Worker not ready or non-TS file — no symbols, no error surface.
        if (filePathRef.current === path) {
          navTreeRef.current = null;
          navTreePathRef.current = '';
        }
      }
    },
    [language],
  );

  // Re-fetch when the file changes.
  useEffect(() => {
    navTreeRef.current = null;
    navTreePathRef.current = '';
    setSymbolChain([]);
    void fetchNavTree(filePath);
  }, [filePath, fetchNavTree]);

  // ── Cursor subscription (symbol chain update) ────────────────────────────

  useEffect(() => {
    return subscribeCursor((e) => {
      if (e.path !== filePathRef.current) return;
      // If the nav tree isn't ready yet for this file, re-fetch then re-compute.
      if (!navTreeRef.current || navTreePathRef.current !== e.path) {
        void fetchNavTree(e.path);
        return;
      }
      setSymbolChain(enclosingSymbolChain(navTreeRef.current, e.offset));
    });
  }, [fetchNavTree]);

  // ── Dropdown helpers ──────────────────────────────────────────────────────

  const openEntriesDropdown = useCallback(
    (entries: DirEntryDTO[], dirPath: string, rect: DOMRect) => {
      const items = entries.map((entry) => {
        const entryPath = `${dirPath.replace(/\/$/, '')}/${entry.name}`;
        return {
          label: entry.name,
          onClick: () => {
            pendingRef.current = null;
            if (entry.kind === 'file') {
              onOpenFile(entryPath);
            } else {
              // Drill into this folder.
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

  // Stable ref so the dir-listing effect can call the latest openEntriesDropdown
  // without adding it to the mount-time dependency array (subscribe runs once on mount).
  const openEntriesDropdownRef = useRef(openEntriesDropdown);
  openEntriesDropdownRef.current = openEntriesDropdown;

  // ── Dir listing subscription ─────────────────────────────────────────────

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'dirEntries') return;
      // Update cache.
      setDirCache((prev) => new Map(prev).set(msg.path, msg.entries));
      // If this is the response for a pending dropdown, open it now.
      const pending = pendingRef.current;
      if (pending && pending.dirPath === msg.path && msg.entries.length > 0) {
        openEntriesDropdownRef.current(msg.entries, msg.path, pending.rect);
      }
    });
  }, []);

  // ── Path segment click ────────────────────────────────────────────────────

  const handlePathSegmentClick = useCallback(
    (dirPath: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const cached = dirCache.get(dirPath);
      if (cached && cached.length > 0) {
        openEntriesDropdown(cached, dirPath, rect);
      } else {
        // Request the listing; store pending so we can open when it arrives.
        pendingRef.current = { dirPath, rect };
        post({ type: 'readDir', path: dirPath });
      }
    },
    [dirCache, openEntriesDropdown],
  );

  // ── Symbol segment click ──────────────────────────────────────────────────

  const handleSymbolSegmentClick = useCallback(
    (item: SymbolChainItem, e: React.MouseEvent) => {
      e.stopPropagation();
      if (item.siblings.length === 0) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const items = item.siblings.map((sib) => ({
        label: `${kindGlyph(sib.kind)} ${sib.text}`,
        onClick: () => {
          // Reveal the symbol in the already-open editor.
          const model = monaco.editor.getModel(fileUri(filePath));
          if (model) {
            const pos = model.getPositionAt(sib.start);
            setReveal(filePath, { line: pos.lineNumber, column: pos.column });
            // openDefinitionFile triggers subscribeReveal handlers in CodeViewer,
            // which will call takeReveal + setPosition + revealLineInCenter.
            openDefinitionFile(filePath);
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

  // ── Render ────────────────────────────────────────────────────────────────

  if (pathSegments.length === 0) return null;

  return (
    <div className="breadcrumb-bar" aria-label="Breadcrumb navigation">
      {pathSegments.map((seg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are ordered path parts; stable by position
        <span key={`path-${i}`} className="breadcrumb-bar__item">
          {i > 0 && (
            <span className="breadcrumb-bar__sep" aria-hidden>
              <IconChevron size={11} />
            </span>
          )}
          <button
            type="button"
            className="breadcrumb-bar__seg"
            title={`Show siblings in ${seg.dirPath}`}
            onClick={(e) => handlePathSegmentClick(seg.dirPath, e)}
          >
            {seg.name}
          </button>
        </span>
      ))}

      {isTs &&
        symbolChain.map((sym, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: symbol chain is ordered outermost→innermost; stable by position
          <span key={`sym-${i}`} className="breadcrumb-bar__item">
            <span className="breadcrumb-bar__sep" aria-hidden>
              <IconChevron size={11} />
            </span>
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
          </span>
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

// ── Tiny helpers ──────────────────────────────────────────────────────────

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
