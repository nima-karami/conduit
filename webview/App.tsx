import { useEffect, useMemo, useState } from 'react';
import type { HostToWebview } from '../src/protocol';
import type { AgentDefinition, Session } from '../src/types';
import { post, subscribe } from './bridge';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { CenterPane } from './components/CenterPane';
import { RightPane } from './components/RightPane';
import { customizations } from './mock';
import type { ChangeDTO, FileNodeDTO } from '../src/protocol';

type StateMsg = Extract<HostToWebview, { type: 'state' }>;

export function App() {
  const [state, setState] = useState<StateMsg | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [project, setProject] = useState<{ path: string; changes: ChangeDTO[]; files: FileNodeDTO[] } | null>(null);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'state') setState(msg);
      else if (msg.type === 'project') setProject(msg);
    });
  }, []);

  const sessions: Session[] = useMemo(
    () => (state?.groups ?? []).flatMap((g) => g.sessions),
    [state],
  );
  const agents: AgentDefinition[] = state?.agents ?? [];

  // Keep a valid active session selected.
  useEffect(() => {
    if (sessions.length === 0) {
      setActiveId(undefined);
    } else if (!activeId || !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  const active = sessions.find((s) => s.id === activeId);
  const activeProject = active ? active.projectPath.split(/[\\/]/).filter(Boolean).pop() : undefined;

  // Ask the host for git changes + file tree whenever the active project changes.
  useEffect(() => {
    if (active?.projectPath) post({ type: 'requestProject', path: active.projectPath });
  }, [active?.projectPath]);

  const projectData = project && active && project.path === active.projectPath ? project : null;

  return (
    <div className="shell">
      <TopBar
        project={activeProject ?? 'Agent Deck'}
        session={active?.name ?? 'No session'}
      />
      <Sidebar
        groups={state?.groups ?? []}
        agents={agents}
        customizations={customizations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => post({ type: 'newSession' })}
        onKill={(id) => post({ type: 'kill', id })}
        onRename={(id, name) => post({ type: 'rename', id, name })}
        onRelaunch={(id) => post({ type: 'relaunch', id })}
      />
      <CenterPane sessions={sessions} agents={agents} activeId={activeId} onRelaunch={(id) => post({ type: 'relaunch', id })} />
      <RightPane changes={projectData?.changes ?? []} files={projectData?.files ?? []} />
    </div>
  );
}
