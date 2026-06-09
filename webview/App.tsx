import { useState } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { CenterPane } from './components/CenterPane';
import { RightPane } from './components/RightPane';
import { projects, customizations, changes, files } from './mock';

export function App() {
  const allSessions = projects.flatMap((p) => p.sessions.map((s) => ({ ...s, project: p.name })));
  const [activeId, setActiveId] = useState('portfolio');
  const active = allSessions.find((s) => s.id === activeId) ?? allSessions[0];

  return (
    <div className="shell">
      <TopBar project={active.project} session={active.name} branch={active.branch} />
      <Sidebar
        projects={projects}
        customizations={customizations}
        activeId={activeId}
        onSelect={setActiveId}
      />
      <CenterPane
        sessionId={active.id}
        title={active.name}
        agent={active.agentLabel}
        agentId={active.agentId}
        cwd={active.cwd}
      />
      <RightPane changes={changes} files={files} />
    </div>
  );
}
