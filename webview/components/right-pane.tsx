import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangesModel } from '../../src/changes-view-model';
import type { Handle } from '../../src/conduit-mcp/types';
import type { DeleteOutcome } from '../../src/delete-confirm';
import type { ChangeKind, RepoChanges } from '../../src/protocol';
import type { FolderSectionModel } from '../../src/session-sections';
import type { Session } from '../../src/types';
import { CHROME_STR } from '../chrome-strings';
import type { OpenMode } from '../docs';
import type { FsOp } from '../fs-undo';
import { type MoveGrip, panelMoveDragProps } from '../panel-move-grip';
import { reviewModeStatusLabel } from '../review-commit';
import { getReviewNav, subscribeReviewNav } from '../review-nav-store';
import type { ReviewScope } from '../review-scope';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { useWorkbenchChromeState } from '../workbench-chrome-state';
import { ChangesView, type ChangesViewProps } from './changes-view';
import type { MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { FilesView, type FilesViewHandle, type FolderUiCache } from './files-view';
import { MessagesPane } from './messages-pane';
import { ReviewNavigator } from './review-navigator';
import type { SearchPaneHandle, SearchScopeModel } from './search-pane';

/** Imperative handle so App's Mod+Shift+F can switch to the Files tab and focus the search input. */
export interface RightPaneHandle {
  /** `seed` replaces the query (and runs it); without one the previous query is kept and selected. */
  openSearch(seed?: string): void;
  /** Switch to the Files tab and reveal+highlight `path` in the tree. */
  revealInTree(path: string): void;
  /** Switch to Messages, filtered to one handle and/or opened on a thread (card menu, chip). */
  showMessages(filterHandle: Handle | null, threadId?: string): void;
}

/** Where the Messages tab lands; `seq` remounts the pane so a repeat jump re-applies. */
interface MessagesNav {
  filterHandle: Handle | null;
  threadId: string | null;
  seq: number;
}

export function RightPane({
  sessionId,
  sections,
  rowChanges,
  osDropSeam,
  openAsSessionHint,
  reviewRepoChanges,
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
  moveGrip,
  onMoveMenu,
  paneRef,
  recordFsOp,
  onContextPath,
  activeTarget,
  searchScope,
  mcp,
  sessions,
  onOpenSettings,
  ...changesProps
}: Omit<ChangesViewProps, 'model' | 'collapsedRepos'> & {
  sessionId: string | undefined;
  sections: FolderSectionModel[];
  rowChanges: ReadonlyMap<string, ChangeKind>;
  osDropSeam: boolean;
  /** `in <project name>` on the explorer's Open as new session (mf-files §2.8). */
  openAsSessionHint?: string;
  /** Review mode's navigator: every repo's changes, or the session root's when none is
   *  detected (reviewRepoChangesFor). */
  reviewRepoChanges: readonly RepoChanges[] | undefined;
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
  onReviewScope: (scope: ReviewScope, repoRoot?: string) => void;
  reviewMode: boolean;
  // Barless panel: the top-edge grip is the panel-move drag surface.
  moveGrip?: MoveGrip;
  onMoveMenu?: (anchor: DOMRect) => void;
  paneRef?: React.MutableRefObject<RightPaneHandle | null>;
  /** Record a successful fs op into the app-level undo stack. */
  recordFsOp?: (op: FsOp) => void;
  /** Multi-repo auto-follow: report a clicked file/folder path so the active repo follows it. */
  onContextPath?: (absPath: string) => void;
  searchScope?: SearchScopeModel;
  /** Messaging state and requests; the Messages tab is app-wide, not per session. */
  mcp: ConduitMcpApi;
  sessions: readonly Session[];
  onOpenSettings: () => void;
}) {
  // Fully controlled: App's chrome state is the one view authority (sidebar-agent-tree plan T1.3).
  const { rightTab: tab } = useWorkbenchChromeState();
  const navModel = useSyncExternalStore(subscribeReviewNav, getReviewNav);
  const [statusText, setStatusText] = useState('');
  const nextStatusText =
    reviewMode && navModel ? reviewModeStatusLabel(navModel.source) : 'Changes';
  useEffect(() => {
    setStatusText(nextStatusText);
  }, [nextStatusText]);
  // Bridge to the SearchPane's input focus (lives inside FilesView when the Files tab is active).
  const searchPaneRef = useRef<SearchPaneHandle | null>(null);
  // Bridge to FilesView's reveal-in-tree (also only mounted on the Files tab).
  const filesPaneRef = useRef<FilesViewHandle | null>(null);
  // Per-folder tree + collapse cache and the Changes repo collapse set, owned here so they
  // outlive FilesView / ChangesView (each unmounts while the other tab is active) and a session
  // switch.
  const folderUiRef = useRef<FolderUiCache>({ treeCache: new Map(), collapsed: new Set() });
  const changesCollapsedRef = useRef<Set<string>>(new Set());
  const [messagesNav, setMessagesNav] = useState<MessagesNav>({
    filterHandle: null,
    threadId: null,
    seq: 0,
  });

  useImperativeHandle(
    paneRef,
    () => ({
      // App switches the view and opens the panel before calling any of these (runInPane).
      openSearch(seed?: string) {
        // SearchPane may mount in this commit; its layout effect has published the handle by then.
        requestAnimationFrame(() => {
          const pane = searchPaneRef.current;
          if (!pane) return;
          if (seed === undefined) pane.focusInput();
          else pane.setQuery(seed);
        });
      },
      revealInTree(path: string) {
        // FilesView may have just mounted (was on Changes) — reveal next frame.
        requestAnimationFrame(() => filesPaneRef.current?.revealInTree(path));
      },
      showMessages(filterHandle, threadId) {
        setMessagesNav((cur) => ({ filterHandle, threadId: threadId ?? null, seq: cur.seq + 1 }));
      },
    }),
    [],
  );

  return (
    <aside
      id="right-pane"
      className="rightpane"
      data-right-view={tab}
      aria-label={CHROME_STR.view[tab]}
    >
      {/* The panel's move surface now that the tab row is gone (spec §7); the panel context
          menu's move actions are its keyboard alternative. */}
      <div
        className="rightpane__grip"
        title={CHROME_STR.movePanel}
        role="button"
        tabIndex={0}
        aria-label={CHROME_STR.movePanel}
        onClick={(e) => onMoveMenu?.(e.currentTarget.getBoundingClientRect())}
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' ||
            e.key === ' ' ||
            e.key === 'ContextMenu' ||
            (e.shiftKey && e.key === 'F10')
          ) {
            e.preventDefault();
            onMoveMenu?.(e.currentTarget.getBoundingClientRect());
          }
        }}
        {...panelMoveDragProps(moveGrip)}
      >
        <span className="rightpane__grip-bar" aria-hidden />
      </div>
      <span className="sr-only" role="status">
        {statusText}
      </span>
      {tab === 'messages' ? (
        <MessagesPane
          key={messagesNav.seq}
          api={mcp}
          sessions={sessions}
          filterHandle={messagesNav.filterHandle}
          onClearFilter={() => setMessagesNav((cur) => ({ ...cur, filterHandle: null }))}
          onOpenSettings={onOpenSettings}
          initialThreadId={messagesNav.threadId}
        />
      ) : tab === 'changes' ? (
        changesModel.kind === 'no-session' ? (
          <EmptyState
            variant="panel"
            title="No session"
            hint="Start a session to see its changes here."
          />
        ) : reviewMode ? (
          <ReviewNavigator
            model={navModel}
            repoChanges={reviewRepoChanges}
            onAction={changesProps.onAction}
            onRefresh={changesProps.onRefresh}
            onReviewScope={onReviewScope}
          />
        ) : (
          <ChangesView
            model={changesModel}
            collapsedRepos={changesCollapsedRef.current}
            activeTarget={activeTarget}
            {...changesProps}
          />
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
          activeTarget={activeTarget}
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
          searchScope={searchScope}
        />
      )}
    </aside>
  );
}
