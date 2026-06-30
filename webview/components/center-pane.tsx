import { useState } from 'react';
import type { ChangeDTO, FileContentDTO, FileDiffDTO } from '../../src/protocol';
import { resolveSessionIcon } from '../../src/session-icon';
import type { AgentDefinition, Session } from '../../src/types';
import type { OpenDoc, ReviewSource } from '../docs';
import { IconPlus } from '../icons';
import { BreadcrumbBar } from './breadcrumb-bar';
import { CommitDiffView } from './commit-view';
import { CompareDialog } from './compare-dialog';
import { DocTabs } from './doc-tabs';
import { DocView } from './doc-view';
import { GitHistoryView } from './git-history-view';
import { GitIndicatorBar } from './git-indicator-bar';
import type { DockHandlers } from './panel-frame';
import { RepoPicker } from './repo-picker';
import { ReviewSourceControl } from './review-source-control';
import { ReviewView } from './review-view';
import { TerminalPane } from './terminal-pane';
import { WebView } from './web-view';

export function CenterPane({
  sessions,
  agents,
  activeId,
  docs,
  activeDocId,
  files,
  diffs,
  onSelectDoc,
  onCloseDoc,
  onRelaunch,
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
  onCloseReview,
  onSetReviewSource,
  onNewSession,
  showGitIndicator,
  onOpenGitHistory,
  onOpenReview,
  onOpenCommitFile,
  onReviewCommit,
  onDocTitle,
}: {
  sessions: Session[];
  agents: AgentDefinition[];
  activeId: string | undefined;
  docs: OpenDoc[];
  activeDocId: string | null;
  files: Map<string, FileContentDTO>;
  diffs: Map<string, FileDiffDTO>;
  onSelectDoc: (id: string | null) => void;
  onCloseDoc: (id: string) => void;
  onRelaunch: (id: string) => void;
  onTabContextMenu?: (e: React.MouseEvent, doc: OpenDoc) => void;
  onTerminalTabContextMenu?: (e: React.MouseEvent) => void;
  onReorderDoc?: (dragId: string, targetId: string | null) => void;
  /** Double-click a preview commit-diff tab to pin it. */
  onPinDoc?: (id: string) => void;
  dock?: DockHandlers;
  splitId?: string | null;
  onCloseSplit?: () => void;
  onOpenFile?: ((path: string) => void) | undefined;
  /** D11: open a file from a terminal path link, optionally at a line/col. The
   * originating session id routes the doc to the clicked terminal's session. */
  onOpenFileAt?: (path: string, line?: number, col?: number, originSessionId?: string) => void;
  /** D11: reveal a folder from a terminal path link in the OS file manager. */
  onRevealFolder?: (path: string) => void;
  /** terminal-commit-link: open Review scoped to a host-confirmed commit clicked in a terminal. */
  onOpenCommitReview?: (sha: string, sessionId: string) => void;
  // Review tab (R5.5): the singleton Review-changes doc renders ReviewView in the doc
  // area instead of DocView. changesRoot = the active repo, so change paths resolve right.
  changesRoot?: string | undefined;
  changes: ChangeDTO[];
  onReviewRequestDiff: (absPath: string) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
  onCloseReview: () => void;
  /** Switch the Review tab's source from its breadcrumb (back to working / to a commit). */
  onSetReviewSource: (next: ReviewSource) => void;
  // Start the new-session flow from the empty-state CTA.
  onNewSession?: () => void;
  // Git indicator (Slice A): show the branch/worktree strip atop a terminal tab.
  showGitIndicator?: boolean;
  /** Open the git-history graph for the active session (from the indicator's button). */
  onOpenGitHistory?: () => void;
  /** Open the whole-changeset Review tab (from the git band, beside the history button). */
  onOpenReview?: () => void;
  /** Open one of a commit's files as a `commit-diff` tab (pin = double-click) — from the
   *  commit detail rendered inline in the history view. */
  onOpenCommitFile?: (sha: string, file: string, pin: boolean) => void;
  /** Review a commit's changes in the singleton Review tab — from the commit detail's button. */
  onReviewCommit?: (sha: string, subject: string) => void;
  /** A web tab adopted the live page <title>; update its tab label. */
  onDocTitle?: (id: string, title: string) => void;
}) {
  const [compareOpen, setCompareOpen] = useState(false);
  const active = sessions.find((s) => s.id === activeId);
  const running = sessions.filter((s) => s.status === 'running');
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;
  // Prefill the Compare dialog from the singleton Review doc's source so re-opening tweaks the
  // live comparison rather than starting blank (spec 2026-06-30 §2).
  const reviewSourcePrefill = docs.find((d) => d.kind === 'review')?.reviewSource;
  const showDoc = activeDoc !== null;
  // Git band visibility: shown over any GIT-SCOPED surface — the terminal, and the
  // Review/History docs (whose contents track the active repo, which the user can still
  // change from the explorer while they're open). Shown when the indicator is enabled OR
  // the repo picker has something to show (≥2 repos — matches RepoPicker's own self-hide),
  // so an empty bordered strip never renders.
  const indicatorOn = showGitIndicator !== false;
  const repoPickerVisible = (active?.repos?.length ?? 0) >= 2;
  const gitScopedDoc = activeDoc?.kind === 'review' || activeDoc?.kind === 'git-history';
  const reviewActive = activeDoc?.kind === 'review';
  // The Review source control rides the band, so the band must render whenever Review is active —
  // even with the indicator off and <2 repos (spec 2026-06-29-review-changes-polish §A2).
  const showGitBand =
    (!showDoc || gitScopedDoc) && !!active && (indicatorOn || repoPickerVisible || reviewActive);
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
        moveGrip={dock ? { onDragStart: dock.onDragStart, onDragEnd: dock.onDragEnd } : undefined}
      />

      {/* Breadcrumb bar (E3): show for file/diff docs (not terminal, not review). */}
      {activeDoc && activeDoc.kind === 'file' && onOpenFile && (
        <BreadcrumbBar
          filePath={activeDoc.path}
          language={files.get(activeDoc.path)?.language ?? ''}
          activeSession={active}
          onOpenFile={onOpenFile}
        />
      )}

      {/* Git band (terminal + the repo-scoped Review/History docs): the repo picker (multi-repo
          awareness) sits beside the branch indicator. Each self-hides — the picker for 0–1
          repos, the indicator when the setting is off or git is kind 'none'/undefined. */}
      {showGitBand && active && (
        <div className="center-gitband">
          <RepoPicker
            sessionId={active.id}
            repos={active.repos ?? []}
            activeRepoRoot={active.activeRepoRoot}
            pinned={active.repoPinned}
          />
          {/* The Review source control joins the left picker group (folder/branch); the
              History/Review icons stay pinned to the right inside the indicator. */}
          {activeDoc?.kind === 'review' && (
            <ReviewSourceControl
              source={activeDoc.reviewSource}
              sessionId={activeDoc.sessionId}
              onSetSource={onSetReviewSource}
              onOpenCompare={() => setCompareOpen(true)}
            />
          )}
          {indicatorOn && (
            <GitIndicatorBar
              git={active.git}
              sessionId={active.id}
              onOpenHistory={onOpenGitHistory}
              onOpenReview={onOpenReview}
              onOpenCompare={() => setCompareOpen(true)}
            />
          )}
        </div>
      )}

      <div className="termwrap">
        {/* Terminals stay mounted (hidden while a doc tab is active) so the PTY survives.
            Split mode shows the active + split sessions side by side. */}
        <div className="termstack" style={{ display: showDoc ? 'none' : 'flex' }}>
          {sessions.length === 0 && (
            <div className="center-empty">
              <img
                src="./icon.png"
                alt="Conduit"
                className="center-empty__logo"
                aria-hidden="true"
              />
              <h1 className="center-empty__brand">Conduit</h1>
              <p className="center-empty__status">No active session</p>
              {onNewSession && (
                <button
                  type="button"
                  className="center-empty__cta"
                  onClick={onNewSession}
                  title="Start a new session"
                >
                  <IconPlus size={15} />
                  New session
                </button>
              )}
            </div>
          )}
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
                  <TerminalPane
                    sessionId={s.id}
                    agentId={s.agentId}
                    cwd={s.cwd ?? s.projectPath}
                    onOpenFile={onOpenFileAt}
                    onRevealFolder={onRevealFolder}
                    onOpenCommitReview={onOpenCommitReview}
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
            </div>
          )}
          {active && active.status === 'exited' && (
            <div className="stale">
              <p className="stale__title">Process exited</p>
              <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>
                ↻ Restart
              </button>
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
            <WebView url={d.path} onTitle={(title) => onDocTitle?.(d.id, title)} />
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
              onClose={onCloseReview}
              source={activeDoc.reviewSource}
              sessionId={activeDoc.sessionId}
              viewStateId={activeDoc.id}
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
            <DocView
              doc={activeDoc}
              file={files.get(activeDoc.path)}
              diff={diffs.get(activeDoc.path)}
              onOpenFile={onOpenFile}
            />
          ))}
      </div>

      {compareOpen && active && (
        <CompareDialog
          sessionId={active.id}
          source={reviewSourcePrefill}
          onCompare={(next) => {
            setCompareOpen(false);
            onSetReviewSource(next);
          }}
          onCancel={() => setCompareOpen(false)}
        />
      )}
    </main>
  );
}
