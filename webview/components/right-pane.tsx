import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { changesBadgeClass } from '../../src/changes-badge';
import type { ChangesModel } from '../../src/changes-view-model';
import type { DeleteOutcome } from '../../src/delete-confirm';
import type { ChangeDTO, ChangeKind } from '../../src/protocol';
import type { FolderSectionModel } from '../../src/session-sections';
import type { RightPaneTab } from '../../src/settings';
import type { OpenMode } from '../docs';
import type { FsOp } from '../fs-undo';
import { type MoveGrip, panelMoveDragProps } from '../panel-move-grip';
import { reviewModeStatusLabel } from '../review-commit';
import { getReviewNav, subscribeReviewNav } from '../review-nav-store';
import type { ReviewScope } from '../review-scope';
import { useSettings } from '../settings';
import { ChangesView, type ChangesViewProps } from './changes-view';
import type { MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { FilesView, type FilesViewHandle, type FolderUiCache } from './files-view';
import { ReviewNavigator } from './review-navigator';
import type { SearchPaneHandle } from './search-pane';

/** Imperative handle so App's Mod+Shift+F can switch to the Files tab and focus the search input. */
export interface RightPaneHandle {
  /** `seed` replaces the query (and runs it); without one the previous query is kept and selected. */
  openSearch(seed?: string): void;
  /** Switch to the Files tab and reveal+highlight `path` in the tree. */
  revealInTree(path: string): void;
  /** Switch to the Changes tab without persisting the choice (review mode). */
  showChanges(): void;
}

export function RightPane({
  reviewFallbackRoot,
  sessionId,
  sections,
  rowChanges,
  osDropSeam,
  openAsSessionHint,
  changes,
  changesModel,
  onOpenFile,
  onOpenMatch,
  setMenu,
  revealPath,
  openExternalApp,
  openWithChooser,
  openAsSession,
  copyToClipboard,
  onDeleteFiles,
  onFileRenamed,
  onReviewScope,
  reviewMode,
  onTabShown,
  moveGrip,
  paneRef,
  recordFsOp,
  onContextPath,
  ...changesProps
}: Omit<ChangesViewProps, 'model'> & {
  /** Review mode's navigator root when no repo is detected: the session's cwd. */
  reviewFallbackRoot: string | undefined;
  sessionId: string | undefined;
  sections: FolderSectionModel[];
  rowChanges: ReadonlyMap<string, ChangeKind>;
  osDropSeam: boolean;
  /** `in <project name>` on the explorer's Open as new session (mf-files §2.8). */
  openAsSessionHint?: string;
  /** The active repo's changes: review mode's navigator. */
  changes: ChangeDTO[];
  changesModel: ChangesModel;
  onOpenFile: (absPath: string, mode?: OpenMode) => void;
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
  onDeleteFiles: (
    nodes: { path: string; kind: 'dir' | 'file' }[],
    afterDeleted: (outcome: DeleteOutcome) => void,
  ) => void;
  onFileRenamed: (fromPath: string, toPath: string) => void;
  /** Review mode's navigator section icons (§2 Lane D). */
  onReviewScope: (scope: ReviewScope) => void;
  reviewMode: boolean;
  onTabShown?: (tab: RightPaneTab) => void;
  // Barless panel: the tab row doubles as the panel-move drag surface (R5 alignment).
  moveGrip?: MoveGrip;
  paneRef?: React.MutableRefObject<RightPaneHandle | null>;
  /** Record a successful fs op into the app-level undo stack. */
  recordFsOp?: (op: FsOp) => void;
  /** Multi-repo auto-follow: report a clicked file/folder path so the active repo follows it. */
  onContextPath?: (absPath: string) => void;
}) {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState<RightPaneTab>(settings.rightPaneTab);
  const navModel = useSyncExternalStore(subscribeReviewNav, getReviewNav);
  const [statusText, setStatusText] = useState('');
  // With no detected repo Review still runs on the session's git root, which is its cwd
  // (gitRootForSession), so the navigator's bulk menu acts there too.
  const navRepoRoot = changesModel.kind === 'ready' ? changesModel.activeRoot : reviewFallbackRoot;
  const nextStatusText =
    reviewMode && navModel ? reviewModeStatusLabel(navModel.source) : 'Changes';
  useEffect(() => {
    setStatusText(nextStatusText);
  }, [nextStatusText]);
  // Explicit tab-button click persists the choice globally; imperative reveal/search switches
  // (openSearch/revealInTree) intentionally do NOT — a transient navigation shouldn't overwrite
  // the remembered preference.
  const selectTab = useCallback(
    (next: RightPaneTab) => {
      setTab(next);
      if (next !== settings.rightPaneTab) update({ rightPaneTab: next });
    },
    [settings.rightPaneTab, update],
  );
  // Adopt the persisted tab when it changes value — covers the async host hydration that
  // lands after mount (so a remembered 'changes' reopens correctly). Fires only on an actual
  // preference change, so a transient reveal/search switch (which doesn't touch the pref) is
  // not snapped back. Never posts — no write loop with the settings broadcast.
  useEffect(() => {
    setTab(settings.rightPaneTab);
  }, [settings.rightPaneTab]);
  useEffect(() => {
    onTabShown?.(tab);
  }, [tab, onTabShown]);
  // Bridge to the SearchPane's input focus (lives inside FilesView when the Files tab is active).
  const searchPaneRef = useRef<SearchPaneHandle | null>(null);
  // Bridge to FilesView's reveal-in-tree (also only mounted on the Files tab).
  const filesPaneRef = useRef<FilesViewHandle | null>(null);
  // Per-folder tree + collapse cache, owned here so it outlives FilesView (which unmounts when
  // the Changes tab is active) and a session switch.
  const folderUiRef = useRef<FolderUiCache>({ treeCache: new Map(), collapsed: new Set() });

  useImperativeHandle(
    paneRef,
    () => ({
      openSearch(seed?: string) {
        setTab('files');
        // Focus after the tab mounts / is already mounted (next frame).
        requestAnimationFrame(() => {
          const pane = searchPaneRef.current;
          if (!pane) return;
          if (seed === undefined) pane.focusInput();
          else pane.setQuery(seed);
        });
      },
      revealInTree(path: string) {
        setTab('files');
        // FilesView may have just mounted (was on Changes) — reveal next frame.
        requestAnimationFrame(() => filesPaneRef.current?.revealInTree(path));
      },
      showChanges() {
        setTab('changes');
      },
    }),
    [],
  );

  return (
    <aside className="right">
      <div className="right__tabs" {...panelMoveDragProps(moveGrip)}>
        <button
          className={`rtab ${tab === 'changes' ? 'rtab--active' : ''}`}
          onClick={() => selectTab('changes')}
        >
          Changes
          {(() => {
            const badgeCount =
              reviewMode && navModel
                ? navModel.files.length
                : changesModel.kind === 'ready'
                  ? changesModel.count
                  : 0;
            const cls = changesBadgeClass(badgeCount, tab === 'changes');
            return cls !== null ? <span className={cls}>{badgeCount}</span> : null;
          })()}
        </button>
        <button
          className={`rtab ${tab === 'files' ? 'rtab--active' : ''}`}
          onClick={() => selectTab('files')}
        >
          Files
        </button>
        <span className="sr-only" role="status">
          {statusText}
        </span>
      </div>
      {tab === 'changes' ? (
        changesModel.kind === 'no-session' ? (
          <EmptyState
            variant="panel"
            title="No session"
            hint="Start a session to see its changes here."
          />
        ) : reviewMode && navRepoRoot !== undefined ? (
          <ReviewNavigator
            model={navModel}
            changes={changes}
            repoRoot={navRepoRoot}
            onAction={changesProps.onAction}
            onRefresh={changesProps.onRefresh}
            onReviewScope={onReviewScope}
          />
        ) : (
          <ChangesView model={changesModel} {...changesProps} />
        )
      ) : sessionId === undefined ? (
        <EmptyState
          variant="panel"
          title="No session"
          hint="Start a session to see its folders here."
        />
      ) : (
        <FilesView
          sessionId={sessionId}
          sections={sections}
          rowChanges={rowChanges}
          osDropSeam={osDropSeam}
          openAsSessionHint={openAsSessionHint}
          onOpenFile={onOpenFile}
          onOpenMatch={onOpenMatch}
          setMenu={setMenu}
          revealPath={revealPath}
          openExternalApp={openExternalApp}
          openWithChooser={openWithChooser}
          openAsSession={openAsSession}
          copyToClipboard={copyToClipboard}
          onDelete={onDeleteFiles}
          onRenamed={onFileRenamed}
          searchPaneRef={searchPaneRef}
          filesPaneRef={filesPaneRef}
          folderUi={folderUiRef.current}
          recordFsOp={recordFsOp}
          onContextPath={onContextPath}
        />
      )}
    </aside>
  );
}
