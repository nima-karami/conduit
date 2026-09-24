import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeDTO, FileContentDTO, FileDiffDTO, RepoDTO } from '../../src/protocol';
import { gitOf } from '../../src/repo-git';
import { resolveSessionIcon } from '../../src/session-icon';
import type { RightPaneTab } from '../../src/settings';
import type { AgentDefinition, Session } from '../../src/types';
import { diffTabKey } from '../diff-tab-scope';
import type { OpenDoc, OpenMode, ReviewSource } from '../docs';
import type { GitActionIntent } from '../git-intent';
import { IconClock } from '../icons';
import type { ReviewScope } from '../review-scope';
import { getTimerSnapshot, subscribeTimers, waitingCountFor } from '../timer-store';
import { CommitDiffView } from './commit-view';
import { CompareDialog } from './compare-dialog';
import { DocTabs } from './doc-tabs';
import { DocView } from './doc-view';
import { CenterEmptyState } from './empty-state';
import { GitHistoryView } from './git-history-view';
import { GitIndicatorBar } from './git-indicator-bar';
import type { DockHandlers } from './panel-frame';
import { RepoPicker } from './repo-picker';
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
      className="stale__waiting"
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
  docs,
  activeDocId,
  files,
  diffs,
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
  changesRoot,
  changes,
  onReviewRequestDiff,
  onJumpToHunk,
  onOpenReviewDiff,
  onReviewGitAction,
  onCloseReview,
  onSetReviewSource,
  onNewSession,
  onOpenGitHistory,
  onOpenReview,
  onOpenCommitFile,
  onReviewCommit,
  onDocTitle,
  onOpenWeb,
  flashTabId,
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
  docs: OpenDoc[];
  activeDocId: string | null;
  files: Map<string, FileContentDTO>;
  diffs: Map<string, FileDiffDTO>;
  onSelectDoc: (id: string | null) => void;
  onCloseDoc: (id: string) => void;
  onRelaunch: (id: string) => void;
  /** Open the timed-message dialog for a session — from the stale card's Waiting line. */
  onOpenTimedMessages?: (sessionId: string) => void;
  onTabContextMenu?: (e: React.MouseEvent, doc: OpenDoc) => void;
  onTerminalTabContextMenu?: (e: React.MouseEvent) => void;
  onReorderDoc?: (dragId: string, targetId: string | null) => void;
  /** Double-click a preview commit-diff tab to pin it. */
  onPinDoc?: (id: string) => void;
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
  // area instead of DocView. changesRoot = the active repo, so change paths resolve right.
  changesRoot?: string | undefined;
  changes: ChangeDTO[];
  onReviewRequestDiff: (absPath: string, scope: ReviewScope) => void;
  onJumpToHunk: (absPath: string, line: number, mode?: OpenMode) => void;
  /** Review card "Open side-by-side": open this file's Monaco diff starting side-by-side, at
   *  Review's scope. */
  onOpenReviewDiff: (absPath: string, scope: ReviewScope, mode?: OpenMode) => void;
  /** Review action bar: Stage all / Discard all, through the app's existing git-intent handler. */
  onReviewGitAction: (intent: GitActionIntent) => void;
  onCloseReview: () => void;
  /** Switch the Review tab's source from its breadcrumb (back to working / to a commit). */
  onSetReviewSource: (next: ReviewSource) => void;
  // Start the new-session flow from the empty-state CTA.
  onNewSession?: () => void;
  /** Open the git-history graph for the active session (from the indicator's button). */
  onOpenGitHistory?: () => void;
  /** Open the whole-changeset Review tab (from the git band, beside the history button). */
  onOpenReview?: () => void;
  /** Open one of a commit's files as a `commit-diff` tab (pin = double-click) — from the
   *  commit detail rendered inline in the history view. */
  onOpenCommitFile?: (sha: string, file: string, mode: OpenMode) => void;
  /** Review a commit's changes in the singleton Review tab — from the commit detail's button or
   * the code-viewer blame lens (which also passes the file's repo root + owning session so the
   * commit is looked up in that repo, not the pinned one). */
  onReviewCommit?: (sha: string, subject: string, repoRoot?: string, sessionId?: string) => void;
  /** A web tab adopted the live page <title>; update its tab label. */
  onDocTitle?: (id: string, title: string) => void;
  /** A middle-click on a link inside a web tab's page (host-routed, spec 2026-09-22 S14). */
  onOpenWeb?: (url: string, targetSessionId: string, mode: OpenMode) => void;
  /** The tab a background open just touched, for the tab strip's cue. */
  flashTabId?: string | null;
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
  const active = sessions.find((s) => s.id === activeId);
  const running = sessions.filter((s) => s.status === 'running');
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;
  // A diff tab keeps showing what it last rendered while its key is re-read or evicted, so a
  // refresh never flashes "Loading diff…" (spec 2026-09-22-scoped-diff-tabs §2 "Refreshing").
  const heldDiffsRef = useRef(new Map<string, FileDiffDTO>());
  const liveDiff = activeDoc?.kind === 'diff' ? diffs.get(diffTabKey(activeDoc)) : undefined;
  const activeDocKey = activeDoc?.id;
  useEffect(() => {
    const held = heldDiffsRef.current;
    if (activeDocKey && liveDiff) held.set(activeDocKey, liveDiff);
    for (const id of held.keys()) if (!docs.some((d) => d.id === id)) held.delete(id);
  }, [liveDiff, activeDocKey, docs]);
  // Prefill the Compare dialog from the singleton Review doc's source so re-opening tweaks the
  // live comparison rather than starting blank (spec 2026-06-30 §2).
  const reviewSourcePrefill = docs.find((d) => d.kind === 'review')?.reviewSource;
  const showDoc = activeDoc !== null;
  // Git band visibility: branch/dirty state, Review, History and Compare are REPO-scoped, not
  // document-scoped, so the band rides every surface in a session that has a repo. It used to
  // hide over any non-git doc, which meant opening a file silently removed the only entry
  // points to Review and History and left no way to tell why. The trailing slot's width is
  // reserved outside the scrollable tab strip, so tabs overflow past it rather than collide.
  const showGitBand = !!active;
  // Web tabs stay mounted across tab/session switches (like terminals) so a page never
  // reloads when you switch away and back; only the active one is visible.
  const webDocs = docs.filter((d) => d.kind === 'web');

  return (
    <main
      className={`center ${dock?.isOver ? 'center--droptarget' : ''}`}
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
        <>
          <DocTabs
            docs={docs}
            activeId={activeDocId}
            terminalLabel={active?.name ?? 'Terminal'}
            terminalIcon={
              active ? resolveSessionIcon(active, agents) : { type: 'kind', kind: 'terminal' }
            }
            onSelect={onSelectDoc}
            onClose={onCloseDoc}
            onTabContextMenu={onTabContextMenu}
            onTerminalTabContextMenu={onTerminalTabContextMenu}
            onReorder={onReorderDoc}
            onPinDoc={onPinDoc}
            flashTabId={flashTabId}
            moveGrip={
              dock ? { onDragStart: dock.onDragStart, onDragEnd: dock.onDragEnd } : undefined
            }
            trailing={
              /* §7.7: the git chrome is right-aligned INSIDE the tab row, not a fourth stacked
             band. Each piece still self-hides — the picker below 2 repos, the indicator when
             git is kind 'none'. */
              showGitBand && active ? (
                <>
                  <RepoPicker
                    sessionId={active.id}
                    repos={active.repos ?? []}
                    activeRepoRoot={active.activeRepoRoot}
                    pinned={active.repoPinned}
                  />
                  <GitIndicatorBar
                    git={gitOf(active)}
                    sessionId={active.id}
                    onOpenHistory={onOpenGitHistory}
                    onOpenReview={onOpenReview}
                  />
                </>
              ) : undefined
            }
          />
          <TrustPrompt />

          <div className="termwrap">
            {/* Terminals stay mounted (hidden while a doc tab is active) so the PTY survives.
            Split mode shows the active + split sessions side by side. */}
            <div className="termstack" style={{ display: showDoc ? 'none' : 'flex' }}>
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
                        <button
                          className="termhost__close"
                          title="Close split"
                          onClick={onCloseSplit}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    <div className="termhost__body">
                      <TerminalPane
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
              {active && active.status === 'stale' && (
                <div className="stale">
                  <p className="stale__title">Session not running</p>
                  <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>
                    ↻ Relaunch
                  </button>
                  {onOpenTimedMessages && (
                    <WaitingLine
                      sessionId={active.id}
                      onOpen={() => onOpenTimedMessages(active.id)}
                    />
                  )}
                </div>
              )}
              {active && active.status === 'exited' && (
                <div className="stale">
                  <p className="stale__title">Process exited</p>
                  <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>
                    ↻ Restart
                  </button>
                  {onOpenTimedMessages && (
                    <WaitingLine
                      sessionId={active.id}
                      onOpen={() => onOpenTimedMessages(active.id)}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Web tabs: always mounted, only the active one visible (keeps pages warm). */}
            {webDocs.map((d) => (
              <div
                key={d.id}
                className="webhost"
                style={{ display: d.id === activeDocId ? 'flex' : 'none' }}
              >
                <WebView
                  url={d.path}
                  onTitle={(title) => onDocTitle?.(d.id, title)}
                  onOpenLink={(url, background) =>
                    onOpenWeb?.(url, d.sessionId, background ? 'background' : 'permanent')
                  }
                />
              </div>
            ))}

            {showDoc &&
              activeDoc &&
              activeDoc.kind !== 'web' &&
              (activeDoc.kind === 'review' ? (
                <ReviewView
                  changesRoot={changesRoot}
                  changes={changes}
                  diffs={diffs}
                  onRequestDiff={onReviewRequestDiff}
                  onJumpToHunk={onJumpToHunk}
                  onOpenDiff={onOpenReviewDiff}
                  onGitAction={onReviewGitAction}
                  onClose={onCloseReview}
                  source={activeDoc.reviewSource}
                  sessionId={activeDoc.sessionId}
                  sessionLabel={active?.name}
                  viewStateId={activeDoc.id}
                  onSetSource={onSetReviewSource}
                  onOpenCompare={() => setCompareOpen(true)}
                  paneTab={paneTab}
                  explorerCollapsed={explorerCollapsed}
                  onTogglePanel={onTogglePanel}
                  onShowChanges={onShowChanges}
                />
              ) : activeDoc.kind === 'git-history' ? (
                <GitHistoryView
                  sessionId={activeDoc.sessionId}
                  viewStateId={activeDoc.id}
                  onOpenCommitFile={onOpenCommitFile}
                  onReviewCommit={onReviewCommit}
                />
              ) : activeDoc.kind === 'commit-diff' ? (
                <CommitDiffView sessionId={activeDoc.sessionId} path={activeDoc.path} />
              ) : (
                // Diff/file viewer state (Monaco model, side-by-side toggle) is per doc; without
                // this key React reuses one instance across docs and the first diff ever opened
                // leaks its side-by-side state into every later one.
                <DocView
                  key={activeDoc.id}
                  doc={activeDoc}
                  file={files.get(activeDoc.path)}
                  diff={liveDiff ?? heldDiffsRef.current.get(activeDoc.id)}
                  activeSession={active}
                  onOpenFile={onOpenFile}
                  onReviewCommit={onReviewCommit}
                  onClearSideBySide={onClearSideBySide}
                  onCloseDoc={onCloseDoc}
                  onRetryDiff={onRetryDiff}
                  onOpenFullDiff={onOpenFullDiff}
                />
              ))}
          </div>
        </>
      )}

      {compareOpen && active && (
        <CompareDialog
          sessionId={active.id}
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
