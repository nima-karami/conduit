import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { DeleteOutcome } from '../../src/delete-confirm';
import { dropIntent, topLevelPaths } from '../../src/drop-intent';
import { folderKey } from '../../src/folder-key';
import type { ConflictPolicy } from '../../src/fs-dnd';
import type { ChangeKind } from '../../src/protocol';
import { type FolderSectionModel, folderForPath } from '../../src/session-sections';
import { fsDndCopy, fsDndImport, fsDndMove, pathForDroppedFile } from '../bridge';
import type { OpenMode } from '../docs';
import { isSearchActive, joinPath, parentDir, type TreeNode } from '../file-tree';
import type { FsOp } from '../fs-undo';
import { pushToast } from '../toast-store';
import { ConflictDialog, type ConflictPrompt, type ConflictResolution } from './conflict-dialog';
import type { MenuState } from './context-menu';
import {
  type FilesPaneApi,
  FolderSection,
  type FolderSectionHandle,
  isOsFileDrag,
  nameOf,
} from './folder-section';
import { SearchPane, type SearchPaneHandle } from './search-pane';

// Fallback row height (px) used before a real `.filerow` is measured; corrected on first mount.
const DEFAULT_ROW_HEIGHT = 25;

declare global {
  interface Window {
    /** Dev/test perf counters read by the explorer virtualization smoke check (numbers only). */
    __conduitFilesPerf?: { mountedRowCount: number; totalRowCount: number };
  }
}

export interface FilesViewHandle {
  /** Expand the owning folder's tree down to `absPath`, loading dirs as needed, and highlight it. */
  revealInTree(absPath: string): void;
}

/** Keyed by folderKey; owned by RightPane so it outlives this view and a session switch. */
export interface FolderUiCache {
  treeCache: Map<string, TreeNode[]>;
  collapsed: Set<string>;
}

export interface FilesViewProps {
  sessionId: string;
  sections: FolderSectionModel[];
  rowChanges: ReadonlyMap<string, ChangeKind>;
  /** about?.e2e === true */
  osDropSeam: boolean;
  /** `in <project name>` */
  openAsSessionHint?: string;
  folderUi: FolderUiCache;
  // `mode` lets the explorer double-click open a permanent tab while single-click previews.
  onOpenFile: (absPath: string, mode?: OpenMode) => void;
  /** Multi-repo auto-follow: report a clicked file/folder path so the active repo follows it. */
  onContextPath?: (absPath: string) => void;
  onOpenMatch: (abs: string, line: number, column: number, mode?: OpenMode) => void;
  setMenu: (m: MenuState | null) => void;
  revealPath: (path: string) => void;
  /** Open a file with its OS-default app (shell.openPath). */
  openExternalApp: (path: string) => void;
  /** Open the OS "Open with…" application chooser for a file. */
  openWithChooser: (path: string) => void;
  /** Open the New Session flow prefilled with a folder as the working directory. */
  openAsSession: (dir: string) => void;
  copyToClipboard: (text: string) => void;
  filesPaneRef: React.MutableRefObject<FilesViewHandle | null>;
  // App owns the destructive flow (confirm + recycle-bin / permanent fallback + closing
  // any open doc tab for each deleted file). It reports each pass's outcome so the tree
  // refreshes the affected parents and announces what happened.
  onDelete: (
    nodes: { path: string; kind: 'dir' | 'file' }[],
    afterDeleted: (outcome: DeleteOutcome) => void,
  ) => void;
  // A file was renamed on disk; app updates/closes any open doc tab for the old path.
  onRenamed: (fromPath: string, toPath: string) => void;
  // Forwarded so the parent's openSearch() can focus the search input.
  searchPaneRef: React.MutableRefObject<SearchPaneHandle | null>;
  /** Record a successful fs op into the app-level undo stack. */
  recordFsOp?: (op: FsOp) => void;
}

export function FilesView({
  sections,
  rowChanges,
  openAsSessionHint,
  folderUi,
  onOpenFile,
  onContextPath,
  onOpenMatch,
  setMenu,
  revealPath,
  openExternalApp,
  openWithChooser,
  openAsSession,
  copyToClipboard,
  filesPaneRef,
  onDelete,
  onRenamed,
  searchPaneRef,
  recordFsOp,
}: FilesViewProps) {
  const present = sections.filter((s) => !s.missing);
  const presentRef = useRef(present);
  presentRef.current = present;
  const homePath = present[0]?.path;
  const [searchText, setSearchText] = useState('');
  // D5 drag-and-drop, pane-wide so moves between folders work (spec §2.2). `draggedPaths` is the
  // internal drag set ([] for an OS-origin drag); `dropTargetPath` is the SINGLE folder path to
  // highlight — keyed on its own path so only one row or section lights up (spec M1).
  const [draggedPaths, setDraggedPaths] = useState<string[]>([]);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  // True while a drag/paste batch is committing — blocks a second drop / paste (no double-submit).
  const [committing, setCommitting] = useState(false);
  const committingRef = useRef(false);
  committingRef.current = committing;
  // The active name-collision prompt (resolves the batch loop's awaited choice), or null.
  const [conflict, setConflict] = useState<{
    prompt: ConflictPrompt;
    resolve: (r: ConflictResolution) => void;
  } | null>(null);
  // In-app cut/copy clipboard of paths (keyboard drag-alternative, WCAG 2.5.7). Not the OS clipboard.
  const [clipboard, setClipboard] = useState<{ op: 'move' | 'copy'; paths: string[] } | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const [, setLayoutTick] = useState(0);

  const handles = useRef(new Map<string, FolderSectionHandle>());
  const handleRefs = useRef(new Map<string, (h: FolderSectionHandle | null) => void>());
  const handleRefFor = (key: string) => {
    let fn = handleRefs.current.get(key);
    if (!fn) {
      fn = (h) => {
        if (h) handles.current.set(key, h);
        else handles.current.delete(key);
      };
      handleRefs.current.set(key, fn);
    }
    return fn;
  };
  const sectionFor = useCallback((abs: string) => {
    const owner = folderForPath(
      presentRef.current.map((s) => s.path),
      abs,
    );
    return owner === undefined ? undefined : handles.current.get(folderKey(owner));
  }, []);

  // Row-list virtualization over ONE shared scroller: every section windows its own rows
  // against it (webview/tree-window.ts computeSectionWindow), so N folders stay bounded.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

  // A callback ref re-measures and rebinds the observer on every (re)mount. The same observer
  // watches each section, so one growing re-renders the others: their offsets moved.
  const resizeObs = useRef<ResizeObserver | null>(null);
  const setScrollerRef = useCallback((el: HTMLDivElement | null) => {
    resizeObs.current?.disconnect();
    resizeObs.current = null;
    scrollerRef.current = el;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
      setLayoutTick((t) => t + 1);
    });
    ro.observe(el);
    resizeObs.current = ro;
  }, []);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const ro = resizeObs.current;
    if (!el || !ro) return;
    for (const child of el.children) ro.observe(child);
  });

  // Measure a real row's height (font-scale-dependent, so not a constant). Runs each render but
  // only writes on a change, so it self-settles.
  useLayoutEffect(() => {
    const el = scrollerRef.current?.querySelector<HTMLElement>('.filerow');
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - rowHeightRef.current) > 0.5) setRowHeight(h);
  });
  // A --font-scale change (a style edit on <html>) resizes rows via CSS without a React render,
  // so re-measure on that mutation too.
  useEffect(() => {
    const remeasure = () => {
      const el = scrollerRef.current?.querySelector<HTMLElement>('.filerow');
      if (!el) return;
      const h = el.getBoundingClientRect().height;
      if (h > 0 && Math.abs(h - rowHeightRef.current) > 0.5) setRowHeight(h);
    };
    const obs = new MutationObserver(remeasure);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => obs.disconnect();
  }, []);

  const scrollTo = useCallback((top: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const rh = rowHeightRef.current;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rh > el.scrollTop + el.clientHeight) el.scrollTop = top + rh - el.clientHeight;
    setScrollTop(el.scrollTop);
  }, []);

  // The pane's figure is the sum over every section (spec §2.2).
  const perf = useRef(new Map<string, { mountedRowCount: number; totalRowCount: number }>());
  const onPerf = useCallback(
    (key: string, counts: { mountedRowCount: number; totalRowCount: number }) => {
      if (counts.mountedRowCount === 0 && counts.totalRowCount === 0) perf.current.delete(key);
      else perf.current.set(key, counts);
      let mountedRowCount = 0;
      let totalRowCount = 0;
      for (const c of perf.current.values()) {
        mountedRowCount += c.mountedRowCount;
        totalRowCount += c.totalRowCount;
      }
      window.__conduitFilesPerf = { mountedRowCount, totalRowCount };
    },
    [],
  );

  useImperativeHandle(
    filesPaneRef,
    () => ({
      revealInTree(absPath: string) {
        // A search overlay hides the tree — clear it (both the SearchPane's own state and
        // our mirror) so the revealed file is actually visible in the tree below.
        searchPaneRef.current?.clear();
        setSearchText('');
        sectionFor(absPath)?.revealInTree(absPath);
      },
    }),
    [searchPaneRef, sectionFor],
  );

  /** Announce an outcome via the polite live region (things only visible users get from toasts). */
  const announce = useCallback((msg: string) => {
    if (liveRef.current) liveRef.current.textContent = msg;
  }, []);

  /** Prompt for a name collision; resolves the batch loop's awaited choice. */
  const promptConflict = (destPath: string, remaining: number) =>
    new Promise<ConflictResolution>((resolve) => {
      const existing = sectionFor(destPath)?.nodeAt(destPath);
      setConflict({
        prompt: {
          name: nameOf(destPath),
          targetName: nameOf(parentDir(destPath)),
          destIsDir: existing?.kind === 'dir',
          destChildCount: existing?.children?.length,
          remaining,
        },
        resolve: (r) => {
          setConflict(null);
          resolve(r);
        },
      });
    });

  const callDnd = (op: 'move' | 'copy', source: string, dest: string, policy: ConflictPolicy) =>
    op === 'copy'
      ? fsDndCopy(source, dest, { onConflict: policy })
      : fsDndMove(source, dest, { onConflict: policy });

  const refreshDir = (dir: string) => sectionFor(dir)?.refreshDir(dir);

  /**
   * Drive N single-item move/copy ops with per-item conflict resolution. First attempt uses the
   * 'error' policy to detect a collision; on EEXIST it prompts (or applies a sticky "apply to
   * all" choice). A non-conflict failure stops the batch and reports (items so far stay applied,
   * each its own undo entry). Selection + focus follow the landed items.
   */
  const runBatch = async (
    items: { source: string; op: 'move' | 'copy'; dest: string }[],
    targetDir: string,
  ) => {
    if (items.length === 0 || committingRef.current) return;
    setCommitting(true);
    let sticky: ConflictResolution['action'] | null = null;
    const landed: string[] = [];
    const refreshDirs = new Set<string>([targetDir]);
    const verb = items[0].op === 'copy' ? 'Copied' : 'Moved';
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let res = await callDnd(it.op, it.source, it.dest, 'error');
        if (!res.ok && res.code === 'EEXIST') {
          let action = sticky;
          if (!action) {
            const r = await promptConflict(it.dest, items.length - i - 1);
            action = r.action;
            if (r.applyToAll) sticky = r.action;
          }
          if (action === 'cancel') {
            announce(`Skipped ${nameOf(it.source)}`);
            continue;
          }
          res = await callDnd(
            it.op,
            it.source,
            it.dest,
            action === 'replace' ? 'replace' : 'rename',
          );
        }
        if (!res.ok) {
          pushToast({
            message: `Couldn't ${it.op} ${nameOf(it.source)}: ${res.error}`,
            variant: 'error',
          });
          break;
        }
        recordFsOp?.({ kind: it.op, from: it.source, to: res.path });
        landed.push(res.path);
        if (it.op === 'move') refreshDirs.add(parentDir(it.source));
        refreshDirs.add(parentDir(res.path));
      }
    } finally {
      setCommitting(false);
    }
    for (const d of refreshDirs) refreshDir(d);
    if (landed.length > 0) {
      sectionFor(targetDir)?.selectMany(landed);
      announce(
        `${verb} ${landed.length} item${landed.length === 1 ? '' : 's'} to ${nameOf(targetDir)}`,
      );
    }
  };

  /** Build move/copy items from sources + a target folder, then run the batch. */
  const moveOrCopyInto = async (
    sources: string[],
    targetDir: string,
    modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean },
  ) => {
    const items = sources.flatMap((source) => {
      const intent = dropIntent({ source, targetDir, modifiers });
      return intent ? [{ source, op: intent.op, dest: intent.dest }] : [];
    });
    await runBatch(items, targetDir);
  };

  // Import OS files/folders dropped from outside into `targetDir`, one source at a time so a
  // collision opens the same conflict dialog as an internal move (spec §D).
  const importOsPaths = async (paths: string[], targetDir: string) => {
    const sources = paths.filter(Boolean);
    if (sources.length === 0) {
      pushToast({ message: 'Could not read the dropped file paths.', variant: 'error' });
      return;
    }
    if (committingRef.current) return;
    setCommitting(true);
    let sticky: ConflictResolution['action'] | null = null;
    const landed: string[] = [];
    try {
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const destPath = joinPath(targetDir, nameOf(src));
        let res = await fsDndImport([src], targetDir, { onConflict: 'error' });
        if (!res.ok && res.code === 'EEXIST') {
          let action = sticky;
          if (!action) {
            const r = await promptConflict(destPath, sources.length - i - 1);
            action = r.action;
            if (r.applyToAll) sticky = r.action;
          }
          if (action === 'cancel') {
            announce(`Skipped ${nameOf(src)}`);
            continue;
          }
          res = await fsDndImport([src], targetDir, {
            onConflict: action === 'replace' ? 'replace' : 'rename',
          });
        }
        if (!res.ok) {
          pushToast({ message: `Couldn't add ${nameOf(src)}: ${res.error}`, variant: 'error' });
          break;
        }
        landed.push(...res.paths);
      }
    } finally {
      setCommitting(false);
    }
    refreshDir(targetDir);
    if (landed.length > 0) {
      const n = landed.length;
      announce(`Added ${n} item${n === 1 ? '' : 's'} to ${nameOf(targetDir)}`);
      pushToast({
        message: `Added ${n} item${n === 1 ? '' : 's'} to the project.`,
        variant: 'info',
      });
    }
  };

  const pane: FilesPaneApi = {
    draggedPaths,
    dropTargetPath,
    committing,
    hasClipboard: clipboard !== null,
    setDropTarget: setDropTargetPath,
    startDrag(paths, e) {
      const top = topLevelPaths(paths);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', top.join('\n'));
      setDraggedPaths(top);
    },
    endDrag() {
      setDraggedPaths([]);
      setDropTargetPath(null);
    },
    dropInternal(sources, targetDir, modifiers) {
      setDraggedPaths([]);
      void moveOrCopyInto(sources, targetDir, modifiers);
    },
    dropOs(e, targetDir) {
      const files = Array.from(e.dataTransfer.files ?? []);
      void importOsPaths(
        files.map((f) => pathForDroppedFile(f)),
        targetDir,
      );
    },
    cut(paths) {
      const eff = topLevelPaths(paths);
      if (eff.length === 0) return;
      setClipboard({ op: 'move', paths: eff });
      announce(`Cut ${eff.length} item${eff.length === 1 ? '' : 's'}`);
    },
    copy(paths) {
      const eff = topLevelPaths(paths);
      if (eff.length === 0) return;
      setClipboard({ op: 'copy', paths: eff });
      announce(`Copied ${eff.length} item${eff.length === 1 ? '' : 's'}`);
    },
    paste(targetDir) {
      if (!clipboard) return;
      const cb = clipboard;
      void moveOrCopyInto(cb.paths, targetDir, { ctrl: cb.op === 'copy' }).then(() => {
        if (cb.op === 'move') setClipboard(null);
      });
    },
    clearClipboard: () => setClipboard(null),
    announce,
    scrollTo,
  };

  const toggleCollapsed = (key: string) => {
    if (folderUi.collapsed.has(key)) folderUi.collapsed.delete(key);
    else folderUi.collapsed.add(key);
    setLayoutTick((t) => t + 1);
  };

  const searchActive = isSearchActive(searchText);

  return (
    <>
      {/* hideResultsWhenEmpty keeps the search bar compact while the tree shows below. */}
      <SearchPane
        projectPath={homePath}
        onOpenMatch={onOpenMatch}
        paneRef={searchPaneRef}
        onTextChange={setSearchText}
        hideResultsWhenEmpty={!searchActive}
      />
      {/* Kept mounted while search is active so every section keeps its tree state. */}
      <div
        ref={setScrollerRef}
        hidden={searchActive}
        className="right__scroll right__scroll--files"
        onScroll={() => {
          const el = scrollerRef.current;
          if (el) setScrollTop(el.scrollTop);
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget || homePath === undefined) return;
          e.preventDefault();
          handles.current.get(folderKey(homePath))?.openRootMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            for (const h of handles.current.values()) h.clearSelection();
          }
          setMenu(null);
        }}
        // Space outside every section targets home (the first present folder).
        onDragOver={(e) => {
          if (homePath === undefined) return;
          if (draggedPaths.length === 0 && !isOsFileDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = draggedPaths.length > 0 && !e.ctrlKey ? 'move' : 'copy';
          setDropTargetPath(homePath);
        }}
        onDragLeave={(e) => {
          // Fires only when the drag leaves the scroller entirely (relatedTarget is outside
          // it), so clear whatever was highlighted — a section OR a specific folder row.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropTargetPath(null);
        }}
        onDrop={(e) => {
          if (homePath === undefined) return;
          if (draggedPaths.length === 0 && (e.dataTransfer.files?.length ?? 0) === 0) return;
          e.preventDefault();
          setDropTargetPath(null);
          if (draggedPaths.length > 0) {
            pane.dropInternal(draggedPaths, homePath, {
              ctrl: e.ctrlKey,
              shift: e.shiftKey,
              alt: e.altKey,
            });
          } else pane.dropOs(e, homePath);
        }}
      >
        {present.map((section) => (
          <FolderSection
            key={section.key}
            section={section}
            pane={pane}
            view={{ scrollTop, viewportHeight, rowHeight }}
            collapsed={folderUi.collapsed.has(section.key)}
            onToggleCollapsed={() => toggleCollapsed(section.key)}
            treeCache={folderUi.treeCache}
            rowChanges={rowChanges}
            openAsSessionHint={openAsSessionHint}
            onPerf={onPerf}
            handleRef={handleRefFor(section.key)}
            onOpenFile={onOpenFile}
            onContextPath={onContextPath}
            setMenu={setMenu}
            revealPath={revealPath}
            openExternalApp={openExternalApp}
            openWithChooser={openWithChooser}
            openAsSession={openAsSession}
            copyToClipboard={copyToClipboard}
            onDelete={onDelete}
            onRenamed={onRenamed}
            recordFsOp={recordFsOp}
          />
        ))}
      </div>
      <div ref={liveRef} className="sr-only" aria-live="polite" role="status" />
      {conflict && (
        <ConflictDialog prompt={conflict.prompt} onResolve={(r) => conflict.resolve(r)} />
      )}
    </>
  );
}
