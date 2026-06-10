import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { HostToWebview } from '../src/protocol';
import type { AgentDefinition, Session } from '../src/types';
import { post, subscribe } from './bridge';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { CenterPane } from './components/CenterPane';
import { RightPane } from './components/RightPane';
import { NewSessionModal } from './components/NewSessionModal';
import { customizations } from './mock';
import { docsReducer, initialDocs } from './docs';
import type { FileContentDTO, FileDiffDTO } from '../src/protocol';
type StateMsg = Extract<HostToWebview, { type: 'state' }>;
type ProjectMsg = Extract<HostToWebview, { type: 'project' }>;

const joinPath = (base: string, rel: string) =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.replace(/\\/g, '/');

export function App() {
  const [state, setState] = useState<StateMsg | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [project, setProject] = useState<ProjectMsg | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [docState, dispatchDocs] = useReducer(docsReducer, initialDocs);
  const [files, setFiles] = useState<Map<string, FileContentDTO>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, FileDiffDTO>>(new Map());

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'state') setState(msg);
      else if (msg.type === 'project') setProject(msg);
      else if (msg.type === 'fileContent') setFiles((m) => new Map(m).set(msg.doc.path, msg.doc));
      else if (msg.type === 'fileDiff') setDiffs((m) => new Map(m).set(msg.doc.path, msg.doc));
    });
  }, []);

  const sessions: Session[] = useMemo(
    () => (state?.groups ?? []).flatMap((g) => g.sessions),
    [state],
  );
  const agents: AgentDefinition[] = state?.agents ?? [];

  // Auto-switch to a newly created (running) session.
  const knownIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const added = sessions.filter((s) => !knownIds.current.has(s.id));
    knownIds.current = new Set(sessions.map((s) => s.id));
    const newest = added
      .filter((s) => s.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest) setActiveId(newest.id);
  }, [sessions]);

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

  // Merge live customization counts (from the host) into the labelled list.
  const mergedCustomizations = useMemo(() => {
    const counts = new Map<string, number>((projectData?.customizations ?? []).map((c) => [c.id, c.count]));
    return customizations.map((c) => ({ ...c, count: counts.has(c.id) ? counts.get(c.id)! : c.count }));
  }, [projectData]);

  const openFile = (path: string) => {
    if (!files.has(path)) post({ type: 'readFile', path });
    dispatchDocs({ type: 'open', kind: 'file', path });
  };
  const openDiff = (path: string) => {
    post({ type: 'readDiff', path }); // always refresh a diff
    dispatchDocs({ type: 'open', kind: 'diff', path });
  };

  return (
    <div className="shell">
      <TopBar
        project={activeProject ?? 'Agent Deck'}
        session={active?.name ?? 'No session'}
      />
      <Sidebar
        groups={state?.groups ?? []}
        agents={agents}
        customizations={mergedCustomizations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setNewOpen(true)}
        onKill={(id) => post({ type: 'kill', id })}
        onRename={(id, name) => post({ type: 'rename', id, name })}
        onRelaunch={(id) => post({ type: 'relaunch', id })}
      />
      <CenterPane
        sessions={sessions}
        agents={agents}
        activeId={activeId}
        docs={docState.docs}
        activeDocId={docState.activeId}
        files={files}
        diffs={diffs}
        onSelectDoc={(id) => dispatchDocs({ type: 'activate', id })}
        onCloseDoc={(id) => dispatchDocs({ type: 'close', id })}
        onRelaunch={(id) => post({ type: 'relaunch', id })}
      />
      <RightPane
        projectPath={active?.projectPath}
        changes={projectData?.changes ?? []}
        onOpenFile={openFile}
        onOpenDiff={(rel) => active?.projectPath && openDiff(joinPath(active.projectPath, rel))}
      />
      {newOpen && (
        <NewSessionModal
          repos={state?.repos ?? []}
          agents={agents}
          onClose={() => setNewOpen(false)}
          onOpen={(path, agentId) => { post({ type: 'openRepo', path, agentId }); setNewOpen(false); }}
          onBrowse={(agentId) => { post({ type: 'browseRepo', agentId }); setNewOpen(false); }}
        />
      )}
    </div>
  );
}
