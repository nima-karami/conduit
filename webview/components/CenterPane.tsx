import type { AgentDefinition, Session } from '../../src/types';
import { TerminalPane } from './TerminalPane';
import { IconClose, IconPin, IconSparkle } from '../icons';

export function CenterPane({
  sessions,
  agents,
  activeId,
  onRelaunch,
}: {
  sessions: Session[];
  agents: AgentDefinition[];
  activeId: string | undefined;
  onRelaunch: (id: string) => void;
}) {
  const active = sessions.find((s) => s.id === activeId);
  const labelFor = (agentId: string) => agents.find((a) => a.id === agentId)?.label ?? agentId;
  // Keep every running session's terminal mounted so switching never kills it.
  const running = sessions.filter((s) => s.status === 'running');

  return (
    <main className="center">
      <div className="tabbar">
        {active ? (
          <div className="tab tab--active">
            <IconSparkle size={13} className="tab__spark" />
            <span>{active.name}</span>
            <span className="tab__agent">{labelFor(active.agentId)}</span>
          </div>
        ) : (
          <div className="tab tab--active tab--muted">Agent Deck</div>
        )}
        <div className="tabbar__actions">
          <button className="iconbtn iconbtn--sm"><IconPin size={14} /></button>
          <button className="iconbtn iconbtn--sm"><IconClose size={14} /></button>
        </div>
      </div>

      <div className="termwrap">
        {sessions.length === 0 && (
          <div className="center-empty">
            <p>No active session.</p>
            <p className="center-empty__hint">Click <strong>New</strong> in the sidebar to start an agent.</p>
          </div>
        )}

        {running.map((s) => (
          <div
            key={s.id}
            className="termhost"
            style={{ display: s.id === activeId ? 'block' : 'none' }}
          >
            <TerminalPane sessionId={s.id} agentId={s.agentId} cwd={s.projectPath} />
          </div>
        ))}

        {active && active.status === 'stale' && (
          <div className="stale">
            <p className="stale__title">Session not running</p>
            <p className="stale__hint">This session was restored from a previous window.</p>
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
    </main>
  );
}
