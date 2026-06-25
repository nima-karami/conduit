/**
 * VS Code-style breadcrumb bar (E3). Path segments (relative to the session cwd) reveal
 * sibling files/dirs; for TS/JS, cursor-driven symbol segments from the TS worker's nav
 * tree are appended. Symbol segments load async (no error if the worker isn't ready).
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
      // Nav tree not ready for this file yet — re-fetch, then a later cursor event recomputes.
      if (!navTreeRef.current || navTreePathRef.current !== e.path) {
        void fetchNavTree(e.path);
        return;
      }
      setSymbolChain(enclosingSymbolChain(navTreeRef.current, e.offset));
    });
  }, [fetchNavTree]);

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
            setReveal(filePath, { line: pos.lineNumber, column: pos.column });
            // Triggers CodeViewer's subscribeReveal → takeReveal + setPosition + reveal.
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

  if (pathSegments.length === 0) return null;

  return (
    <div className="breadcrumb-bar" aria-label="Breadcrumb navigation">
      {pathSegments.map((seg, i) => {
        // The last path segment is the file name — it gets priority for available
        // width (shown in full when it fits, ellipsised only when the bar is too
        // narrow); ancestor dir segments shrink first. See styles.css.
        const isFile = i === pathSegments.length - 1;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are ordered path parts; stable by position
            key={`path-${i}`}
            className={`breadcrumb-bar__item breadcrumb-bar__item--path${isFile ? ' breadcrumb-bar__item--file' : ''}`}
          >
            {i > 0 && (
              <span className="breadcrumb-bar__sep" aria-hidden>
                <IconChevron size={11} />
              </span>
            )}
            <button
              type="button"
              className="breadcrumb-bar__seg"
              title={isFile ? seg.name : `Show siblings in ${seg.dirPath}`}
              onClick={(e) => handlePathSegmentClick(seg.dirPath, e)}
            >
              {seg.name}
            </button>
          </span>
        );
      })}

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
