import type { AgentDefinition, Session } from '../../src/types';
import type { FileContentDTO, FileDiffDTO } from '../../src/protocol';
import type { OpenDoc } from '../docs';
import { TerminalPane } from './TerminalPane';
import { DocTabs } from './DocTabs';
import { DocView } from './DocView';

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
}) {
  const active = sessions.find((s) => s.id === activeId);
  const running = sessions.filter((s) => s.status === 'running');
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;
  const showDoc = activeDoc !== null;

  return (
    <main className="center">
      <DocTabs
        docs={docs}
        activeId={activeDocId}
        terminalLabel={active?.name ?? 'Terminal'}
        onSelect={onSelectDoc}
        onClose={onCloseDoc}
      />

      <div className="termwrap">
        {/* Terminals stay mounted; hidden while a document tab is active. */}
        <div className="termstack" style={{ display: showDoc ? 'none' : 'block' }}>
          {sessions.length === 0 && (
            <div className="center-empty">
              <p>No active session.</p>
              <p className="center-empty__hint">Click <strong>New</strong> to start a terminal.</p>
            </div>
          )}
          {running.map((s) => (
            <div key={s.id} className="termhost" style={{ display: s.id === activeId ? 'block' : 'none' }}>
              <TerminalPane sessionId={s.id} agentId={s.agentId} cwd={s.projectPath} />
            </div>
          ))}
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
