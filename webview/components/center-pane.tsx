import type { ChangeDTO, FileContentDTO, FileDiffDTO } from '../../src/protocol';
import { resolveSessionIcon } from '../../src/session-icon';
import type { AgentDefinition, Session } from '../../src/types';
import type { OpenDoc } from '../docs';
import { IconPlus } from '../icons';
import { BreadcrumbBar } from './breadcrumb-bar';
import { DocTabs } from './doc-tabs';
import { DocView } from './doc-view';
import type { DockHandlers } from './panel-frame';
import { ReviewView } from './review-view';
import { TerminalPane } from './terminal-pane';

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
  dock,
  splitId,
  onCloseSplit,
  onOpenFile,
  onOpenFileAt,
  onRevealFolder,
  projectPath,
  changes,
  onReviewRequestDiff,
  onJumpToHunk,
  onCloseReview,
  onNewSession,
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
  dock?: DockHandlers;
  splitId?: string | null;
  onCloseSplit?: () => void;
  onOpenFile?: ((path: string) => void) | undefined;
  /** D11: open a file from a terminal path link, optionally at a line/col. */
  onOpenFileAt?: (path: string, line?: number, col?: number) => void;
  /** D11: reveal a folder from a terminal path link in the OS file manager. */
  onRevealFolder?: (path: string) => void;
  // Review tab (R5.5): the singleton Review-changes doc renders ReviewView in the doc
  // area instead of DocView.
  projectPath?: string | undefined;
  changes: ChangeDTO[];
  onReviewRequestDiff: (absPath: string) => void;
  onJumpToHunk: (absPath: string, line: number) => void;
  onCloseReview: () => void;
  // Start the new-session flow from the empty-state CTA.
  onNewSession?: () => void;
}) {
  const active = sessions.find((s) => s.id === activeId);
  const running = sessions.filter((s) => s.status === 'running');
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;
  const showDoc = activeDoc !== null;

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

        {showDoc &&
          activeDoc &&
          (activeDoc.kind === 'review' ? (
            <ReviewView
              projectPath={projectPath}
              changes={changes}
              diffs={diffs}
              onRequestDiff={onReviewRequestDiff}
              onJumpToHunk={onJumpToHunk}
              onClose={onCloseReview}
            />
          ) : (
            <DocView
              doc={activeDoc}
              file={files.get(activeDoc.path)}
              diff={diffs.get(activeDoc.path)}
              onOpenFile={onOpenFile}
            />
          ))}
      </div>
    </main>
  );
}
