import type { AgentDefinition, Session } from '../../src/types';
import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { TerminalPane } from './TerminalPane';
import { DocTabs } from './DocTabs';
import { DocView } from './DocView';
import type { DockHandlers } from './PanelFrame';

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
  onReorderDoc,
  dock,
  splitId,
  onCloseSplit,
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
  onReorderDoc?: (dragId: string, targetId: string | null) => void;
  dock?: DockHandlers;
  splitId?: string | null;
  onCloseSplit?: () => void;
}) {
  const active = sessions.find((s) => s.id === activeId);
  const running = sessions.filter((s) => s.status === 'running');
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;
  const showDoc = activeDoc !== null;

  return (
    <main
      className={`center ${dock?.isOver ? 'center--droptarget' : ''}`}
      onDragOver={dock?.onDragOver}
      onDrop={dock ? (e) => { e.preventDefault(); dock.onDrop(); } : undefined}
    >
      <DocTabs
        docs={docs}
        activeId={activeDocId}
        terminalLabel={active?.name ?? 'Terminal'}
        onSelect={onSelectDoc}
        onClose={onCloseDoc}
        onTabContextMenu={onTabContextMenu}
        onReorder={onReorderDoc}
      />

      <div className="termwrap">
        {/* Terminals stay mounted; hidden while a document tab is active. In split
            mode the active + split sessions are shown side by side (same instances). */}
        <div className="termstack" style={{ display: showDoc ? 'none' : 'flex' }}>
          {sessions.length === 0 && (
            <div className="center-empty">
              <p>No active session.</p>
              <p className="center-empty__hint">Click <strong>New</strong> to start a terminal.</p>
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
                    <button className="termhost__close" title="Close split" onClick={onCloseSplit}>✕</button>
                  </div>
                )}
                <div className="termhost__body">
                  <TerminalPane sessionId={s.id} agentId={s.agentId} cwd={s.projectPath} />
                </div>
              </div>
            );
          })}
          {active && active.status === 'stale' && (
            <div className="stale">
              <p className="stale__title">Session not running</p>
              <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>↻ Relaunch</button>
            </div>
          )}
          {active && active.status === 'exited' && (
            <div className="stale">
              <p className="stale__title">Process exited</p>
              <button className="btn btn--primary" onClick={() => onRelaunch(active.id)}>↻ Restart</button>
            </div>
          )}
        </div>

        {showDoc && activeDoc && (
          <DocView
            doc={activeDoc}
            file={files.get(activeDoc.path)}
            diff={diffs.get(activeDoc.path)}
          />
        )}
      </div>
    </main>
  );
}
