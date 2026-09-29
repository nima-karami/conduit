import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FileContentDTO, FileDiffDTO, RepoChanges, RepoDTO } from '../../src/protocol';
import { historyRepoFor, orderRepos } from '../../src/repo-display';
import type { RepoInfo } from '../../src/repo-scan';
import { resolveSessionIcon } from '../../src/session-icon';
import type { RightPaneTab } from '../../src/settings';
import type { AgentDefinition, GitInfo, Session } from '../../src/types';
import { diffTabKey } from '../diff-tab-scope';
import type { CenterLayout, GroupIndex, GroupView } from '../doc-groups';
import type { OpenDoc, OpenMode, ReviewSource } from '../docs';
import { tabStateKey } from '../editor-group-context';
import { useFileSaveStatuses } from '../file-saves';
import type { GitActionIntent } from '../git-intent';
import { IconClock } from '../icons';
import { reviewRequestRoot } from '../review-repos';
import type { ReviewScope } from '../review-scope';
import { getTimerSnapshot, subscribeTimers, waitingCountFor } from '../timer-store';
import { AgentScopeBanner } from './agent-scope-banner';
import { CommitDiffView } from './commit-view';
import { CompareDialog } from './compare-dialog';
import { DocTabs } from './doc-tabs';
import { DocView } from './doc-view';
import { EditorGroupPane } from './editor-group-pane';
import { EditorGroups } from './editor-groups';
import { CenterEmptyState } from './empty-state';
import { GitHistoryView } from './git-history-view';
import { MissingHomeState, StartRefusedState } from './missing-home-state';
import type { DockHandlers } from './panel-frame';
import { ReviewView } from './review-view';
import { TerminalPane } from './terminal-pane';
import { TrustPrompt } from './trust-prompt';
import { WebView } from './web-view';

/**
 * "A timed message is waiting" — on the surface the user is already looking at when they hit the
 * problem, with Relaunch right beside it (spec 2026-08-28-timed-messages §2 "Waiting").
 */
function WaitingLine({ sessionId, onOpen }: { sessionId: string; onOpen: () => void }) {
  const snap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  const count = waitingCountFor(snap, sessionId);
  if (count === 0) return null;
  const label = `${count} timed message${count === 1 ? '' : 's'} waiting`;
  return (
    <button
      type="button"
      className="session-stale__waiting"
      aria-label={`${label} — open`}
      onClick={onOpen}
    >
      <IconClock size={12} />
      {`${label} — ${count === 1 ? 'it' : 'they'} will send when this session starts.`}
    </button>
  );
}

export function CenterPane({
  sessions,
  agents,
  repos,
  activeId,
  layout,
  files,
  diffs,
  onFocusGroup,
  onSplitRight,
  splitDisabledReason,
  onGroupStripContextMenu,
  editorSplitRatio,
  onSplitRatioCommit,
  onSelectDoc,
  onCloseDoc,
  onRelaunch,
  onOpenTimedMessages,
  onTabContextMenu,
  onTerminalTabContextMenu,
  onReorderDoc,
  onPinDoc,
  dock,
  splitId,
  onCloseSplit,
  onOpenFile,
  onOpenFileAt,
  onRevealFolder,
  onOpenCommitReview,
  reviewRepos,
  reviewRepoChanges,
  reviewRepoGit,
  reviewFallbackRoot,
  home,
  onReviewRequestDiff,
  onJumpToHunk,
  onOpenReviewDiff,
  onReviewGitAction,
  onCloseReview,
  onSetReviewSource,
  onNewSession,
  onOpenCommitFile,
  onRetargetHistory,
  onReviewCommit,
  onDocTitle,
  onOpenWeb,
  flashTab,
  paneTab,
  explorerCollapsed,
  onTogglePanel,
  onShowChanges,
  onClearSideBySide,
  onRetryDiff,
  onOpenFullDiff,
}: {
  sessions: Session[];
  agents: AgentDefinition[];
  /** Folder history — the empty state's "Reopen last" route reads it (D8). */
  repos: RepoDTO[];
  activeId: string | undefined;
  layout: CenterLayout;
  files: Map<string, FileContentDTO>;
  diffs: Map<string, FileDiffDTO>;
  onFocusGroup: (group: GroupIndex) => void;
  onSplitRight: () => void;
  splitDisabledReason: string | null;
  onGroupStripContextMenu?: (e: React.MouseEvent, group: GroupIndex) => void;
  editorSplitRatio: number;
  onSplitRatioCommit: (ratio: number) => void;
  onSelectDoc: (id: string | null, group: GroupIndex) => void;
  onCloseDoc: (id: string, group: GroupIndex) => void;
  onRelaunch: (id: string) => void;
  /** Open the timed-message dialog for a session — from the stale card's Waiting line. */
  onOpenTimedMessages?: (sessionId: string) => void;
  onTabContextMenu?: (e: React.MouseEvent, doc: OpenDoc, group: GroupIndex) => void;
  onTerminalTabContextMenu?: (e: React.MouseEvent) => void;
  onReorderDoc?: (dragId: string, targetId: string | null, group: GroupIndex) => void;
  /** Double-click a preview commit-diff tab to pin it. */
  onPinDoc?: (id: string, group: GroupIndex) => void;
  dock?: DockHandlers;
  splitId?: string | null;
  onCloseSplit?: () => void;
  onOpenFile?: ((path: string, mode?: OpenMode) => void) | undefined;
  /** D11: open a file from a terminal path link, optionally at a line/col. The
   * originating session id routes the doc to the clicked terminal's session. */
  onOpenFileAt?: (
    path: string,
    line?: number,
    col?: number,
    originSessionId?: string,
    mode?: OpenMode,
  ) => void;
  /** D11: reveal a folder from a terminal path link in the OS file manager. */
  onRevealFolder?: (path: string) => void;
  /** terminal-commit-link: open Review scoped to a host-confirmed commit clicked in a terminal.
   * `repoRoot` is the terminal's cwd repo so Review reads the commit from there, not the pinned repo. */
  onOpenCommitReview?: (sha: string, sessionId: string, repoRoot?: string) => void;
  // Review tab (R5.5): the singleton Review-changes doc renders ReviewView in the doc
  // area instead of DocView. See ReviewView's props for these four.
  reviewRepos: readonly RepoInfo[];
  reviewRepoChanges: readonly RepoChanges[] | undefined;
  reviewRepoGit: Readonly<Record<string, GitInfo>> | undefined;
  reviewFallbackRoot: string | undefined;
  home: string | undefined;
  onReviewRequestDiff: (absPath: string, scope: ReviewScope) => void;
  onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
  /** Review card "Open side-by-side": open this file's Monaco diff starting side-by-side, at
   *  Review's scope. */
  onOpenReviewDiff: (absPath: string, scope: ReviewScope, mode?: OpenMode) => void;
  /** Review action bar: Stage all / Discard all, through the app's existing git-intent handler. */
  onReviewGitAction: (intent: GitActionIntent) => Promise<void>;
  onCloseReview: () => void;
  /** Switch the Review tab's source from its breadcrumb (back to working / to a commit). */
  onSetReviewSource: (next: ReviewSource) => void;
  // Start the new-session flow from the empty-state CTA.
  onNewSession?: () => void;
  /** Open one of a commit's files as a `commit-diff` tab (pin = double-click) — from the
   *  commit detail rendered inline in the history view. */
  onOpenCommitFile?: (sha: string, file: string, mode: OpenMode, repoRoot?: string) => void;
  onRetargetHistory?: (repoRoot: string) => void;
  /** Review a commit's changes in the singleton Review tab — from the commit detail's button or
   * the code-viewer blame lens (which also passes the file's repo root + owning session so the
   * commit is looked up in that repo, not the pinned one). */
  onReviewCommit?: (sha: string, subject: string, repoRoot?: string, sessionId?: string) => void;
  /** A web tab adopted the live page <title>; update its tab label. */
  onDocTitle?: (id: string, title: string) => void;
  /** A middle-click on a link inside a web tab's page (host-routed, spec 2026-09-22 S14). */
  onOpenWeb?: (url: string, targetSessionId: string, mode: OpenMode) => void;
  /** The tab a background open just touched, for its group's tab strip cue. */
  flashTab: { id: string; group: GroupIndex } | null;
  /** Which right-pane tab is shown — forwarded to the Review header's panel toggle. */
  paneTab: RightPaneTab;
  explorerCollapsed: boolean;
  onTogglePanel: () => void;
  onShowChanges: () => void;
  /** diff docs only: consume the one-time `sideBySide` override once the tab's own toggle fires. */
  onClearSideBySide?: (id: string) => void;
  onRetryDiff: (doc: OpenDoc) => void;
  onOpenFullDiff: (doc: OpenDoc) => void;
}) {
  const [compareOpen, setCompareOpen] = useState(false);
  const saveStatuses = useFileSaveStatuses();
  // Locate / Use-as-home fixed the home: focus the block's Relaunch once it renders (spec §9).
  const [focusRelaunchFor, setFocusRelaunchFor] = useState<string | null>(null);
  const active = sessions.find((s) => s.id === activeId);
  // A fresh callback each render, so a flag set after the block mounted still lands.
  const relaunchRef = (el: HTMLButtonElement | null) => {
    if (el && active && focusRelaunchFor === active.id) {
      el.focus();
      setFocusRelaunchFor(null);
    }
  };
  const running = sessions.filter((s) => s.status === 'running');
  const groupOne = layout.groups[0];
  const shownDocs = layout.groups.flatMap((v) => v.docs.filter((d) => d.id === v.activeDocId));
  // A diff tab keeps showing what it last rendered while its key is re-read or evicted, so a
  // refresh never flashes "Loading diff…" (spec 2026-09-22-scoped-diff-tabs §2 "Refreshing").
  const heldDiffsRef = useRef(new Map<string, FileDiffDTO>());
  useEffect(() => {
    const held = heldDiffsRef.current;
    for (const v of layout.groups) {
      const d = v.docs.find((x) => x.id === v.activeDocId);
      const live = d?.kind === 'diff' ? diffs.get(diffTabKey(d)) : undefined;
      if (d && live) held.set(d.id, live);
    }
    for (const id of held.keys()) {
      if (!layout.groups.some((v) => v.docs.some((d) => d.id === id))) held.delete(id);
    }
  }, [layout, diffs]);
  // Prefill the Compare dialog from the singleton Review doc's source so re-opening tweaks the
  // live comparison rather than starting blank (spec 2026-06-30 §2).
  const reviewSourcePrefill = layout.groups
    .flatMap((v) => v.docs)
    .find((d) => d.kind === 'review')?.reviewSource;
  // Web tabs stay mounted across tab switches so a page never reloads when you switch away and
  // back; only each group's active one is visible.
  const webDocs = layout.groups.flatMap((v) => v.docs.filter((d) => d.kind === 'web'));
  const webPlacement = (id: string) => {
    const v = layout.groups.find((g) => g.docs.some((d) => d.id === id));
    return v ? { group: v.group, visible: v.activeDocId === id } : null;
  };

  const renderDocBody = (doc: OpenDoc, group: GroupIndex) =>
    doc.kind === 'review' ? (
      <ReviewView
        reviewRepos={reviewRepos}
        repoChanges={reviewRepoChanges}
        repoGit={reviewRepoGit}
        fallbackRoot={reviewFallbackRoot}
        home={home}
        diffs={diffs}
        onRequestDiff={onReviewRequestDiff}
        onJumpToHunk={onJumpToHunk}
        onOpenDiff={onOpenReviewDiff}
        onGitAction={onReviewGitAction}
        onClose={onCloseReview}
        source={doc.reviewSource}
        sessionId={doc.sessionId}
        sessionLabel={active?.name}
        viewStateId={tabStateKey(doc.id, group)}
        onSetSource={onSetReviewSource}
        onOpenCompare={() => setCompareOpen(true)}
        paneTab={paneTab}
        explorerCollapsed={explorerCollapsed}
        onTogglePanel={onTogglePanel}
        onShowChanges={onShowChanges}
      />
    ) : doc.kind === 'git-history' ? (
      <GitHistoryView
        sessionId={doc.sessionId}
        repoRoot={historyRepoFor(doc.repoRoot, active)}
        repos={orderRepos(active?.repos ?? [], active?.roots ?? [])}
        onRetarget={(root) => onRetargetHistory?.(root)}
        viewStateId={tabStateKey(doc.id, group)}
        onOpenCommitFile={onOpenCommitFile}
        onReviewCommit={onReviewCommit}
      />
    ) : doc.kind === 'commit-diff' ? (
      <CommitDiffView sessionId={doc.sessionId} path={doc.path} root={doc.repoRoot} />
    ) : (
      // Diff/file viewer state (Monaco model, side-by-side toggle) is per tab; without this key
      // React reuses one instance across docs and the first diff ever opened leaks its
      // side-by-side state into every later one.
      <DocView
        key={tabStateKey(doc.id, group)}
        doc={doc}
        file={files.get(doc.path)}
        diff={
          (doc.kind === 'diff' ? diffs.get(diffTabKey(doc)) : undefined) ??
          heldDiffsRef.current.get(doc.id)
        }
        activeSession={active}
        onOpenFile={onOpenFile}
        onReviewCommit={onReviewCommit}
        onClearSideBySide={onClearSideBySide}
        onCloseDoc={(id) => onCloseDoc(id, group)}
        onRetryDiff={onRetryDiff}
        onOpenFullDiff={onOpenFullDiff}
      />
    );

  const renderShownDoc = (view: GroupView) => {
    const doc = shownDocs.find((d) => d.id === view.activeDocId);
    return doc && doc.kind !== 'web' ? renderDocBody(doc, view.group) : null;
  };

  const terminalStack = (
    // Terminals stay mounted (hidden while a doc tab is active) so the PTY survives. Split mode
    // shows the active + split sessions side by side.
    <div className="termstack" style={{ display: groupOne.activeDocId !== null ? 'none' : 'flex' }}>
      {running.map((s) => {
        const isSplit = s.id === splitId && s.id !== activeId;
        const visible = s.id === activeId || isSplit;
        return (
          <div
            key={s.id}
            className="termhost"
            style={{ display: visible ? 'flex' : 'none', flex: visible ? 1 : undefined }}
          >
            {isSplit && (
              <div className="termhost__bar">
                <span className="termhost__name">{s.name}</span>
                <button className="termhost__close" title="Close split" onClick={onCloseSplit}>
                  ✕
                </button>
              </div>
            )}
            <div className="termhost__body">
              <AgentScopeBanner session={s} />
              <TerminalPane
                key={`${s.id}:${s.restartSeq ?? 0}`}
                sessionId={s.id}
                agentId={s.agentId}
                cwd={s.cwd ?? s.home}
                onOpenFile={onOpenFileAt}
                onRevealFolder={onRevealFolder}
                onOpenCommitReview={onOpenCommitReview}
                onOpenTimedMessages={onOpenTimedMessages}
              />
            </div>
          </div>
        );
      })}
      {active && active.status !== 'running' && active.homeMissing && (
        <div className="session-stale">
          <MissingHomeState session={active} onFixed={() => setFocusRelaunchFor(active.id)} />
          {onOpenTimedMessages && (
            <WaitingLine sessionId={active.id} onOpen={() => onOpenTimedMessages(active.id)} />
          )}
        </div>
      )}
      {active && active.status !== 'running' && !active.homeMissing && active.startRefusal && (
        <div className="session-stale">
          <StartRefusedState session={active} onRelaunch={onRelaunch} relaunchRef={relaunchRef} />
          {onOpenTimedMessages && (
            <WaitingLine sessionId={active.id} onOpen={() => onOpenTimedMessages(active.id)} />
          )}
        </div>
      )}
      {active && active.status === 'stale' && !active.homeMissing && !active.startRefusal && (
        <div className="session-stale">
          <p className="session-stale__title">Session not running</p>
          <button
            ref={relaunchRef}
            className="btn btn--primary"
            onClick={() => onRelaunch(active.id)}
          >
            ↻ Relaunch
          </button>
          {onOpenTimedMessages && (
            <WaitingLine sessionId={active.id} onOpen={() => onOpenTimedMessages(active.id)} />
          )}
        </div>
      )}
      {active && active.status === 'exited' && !active.homeMissing && !active.startRefusal && (
        <div className="session-stale">
          <p className="session-stale__title">Process exited</p>
          <button
            ref={relaunchRef}
            className="btn btn--primary"
            onClick={() => onRelaunch(active.id)}
          >
            ↻ Restart
          </button>
          {onOpenTimedMessages && (
            <WaitingLine sessionId={active.id} onOpen={() => onOpenTimedMessages(active.id)} />
          )}
        </div>
      )}
    </div>
  );

  const renderGroup = (view: GroupView) => {
    const g = view.group;
    return (
      <EditorGroupPane
        key={g}
        group={g}
        active={layout.activeGroup === g}
        onFocusGroup={onFocusGroup}
        top={g === 1 ? <TrustPrompt /> : undefined}
        tabs={
          <DocTabs
            group={g}
            groupActive={layout.activeGroup === g}
            showTerminal={g === 1}
            split={{ disabledReason: splitDisabledReason, onSplit: onSplitRight }}
            onStripContextMenu={
              onGroupStripContextMenu ? (e) => onGroupStripContextMenu(e, g) : undefined
            }
            docs={view.docs}
            activeId={view.activeDocId}
            previewIds={view.previewIds}
            terminalLabel={active?.name ?? 'Terminal'}
            terminalIcon={
              active ? resolveSessionIcon(active, agents) : { type: 'kind', kind: 'terminal' }
            }
            onSelect={(id) => onSelectDoc(id, g)}
            onClose={(id) => onCloseDoc(id, g)}
            onTabContextMenu={
              onTabContextMenu ? (e, doc) => onTabContextMenu(e, doc, g) : undefined
            }
            onTerminalTabContextMenu={g === 1 ? onTerminalTabContextMenu : undefined}
            onReorder={
              onReorderDoc ? (dragId, targetId) => onReorderDoc(dragId, targetId, g) : undefined
            }
            onPinDoc={onPinDoc ? (id) => onPinDoc(id, g) : undefined}
            flashTabId={flashTab?.group === g ? flashTab.id : null}
            saveStatuses={saveStatuses}
            moveGrip={
              dock ? { onDragStart: dock.onDragStart, onDragEnd: dock.onDragEnd } : undefined
            }
          />
        }
      >
        <div className="termwrap">
          {g === 1 && terminalStack}
          {renderShownDoc(view)}
        </div>
      </EditorGroupPane>
    );
  };

  return (
    <main
      className={`centerpane ${dock?.isOver ? 'centerpane--droptarget' : ''}`}
      onDragOver={dock?.onDragOver}
      onDrop={
        dock
          ? (e) => {
              e.preventDefault();
              dock.onDrop();
            }
          : undefined
      }
    >
      {sessions.length === 0 ? (
        <CenterEmptyState repos={repos} agents={agents} onNewSession={onNewSession} />
      ) : (
        <EditorGroups
          layout={layout}
          ratio={editorSplitRatio}
          onRatioCommit={onSplitRatioCommit}
          renderGroup={renderGroup}
          webDocs={webDocs}
          webPlacement={webPlacement}
          renderWeb={(d) => (
            <WebView
              url={d.path}
              onTitle={(title) => onDocTitle?.(d.id, title)}
              onOpenLink={(url, background) =>
                onOpenWeb?.(url, d.sessionId, background ? 'background' : 'permanent')
              }
            />
          )}
          onFocusGroup={onFocusGroup}
        />
      )}

      {compareOpen && active && (
        <CompareDialog
          sessionId={active.id}
          repoRoot={reviewRequestRoot(reviewSourcePrefill, reviewRepos, reviewFallbackRoot)}
          source={reviewSourcePrefill}
          onCompare={(next) => {
            setCompareOpen(false);
            onSetReviewSource(next);
            requestAnimationFrame(() =>
              document.querySelector<HTMLButtonElement>('.review .review__source')?.focus(),
            );
          }}
          onCancel={() => {
            setCompareOpen(false);
            requestAnimationFrame(() =>
              document.querySelector<HTMLButtonElement>('.review .review__source')?.focus(),
            );
          }}
        />
      )}
    </main>
  );
}
