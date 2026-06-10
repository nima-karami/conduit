import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { HostToWebview } from '../src/protocol';
import type { AgentDefinition, Session } from '../src/types';
import { post, subscribe } from './bridge';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { CenterPane } from './components/CenterPane';
import { RightPane } from './components/RightPane';
import { NewSessionModal } from './components/NewSessionModal';
import { SettingsModal } from './components/SettingsModal';
import { CommandPalette, type PaletteEntry } from './components/CommandPalette';
import { customizations } from './mock';
import { docsReducer, initialDocs } from './docs';
import { useSettings } from './settings';
import { THEMES } from './themes';
import { IconTerminal, IconDoc, IconCommand, IconSettings, IconPlus, IconExternal, IconSparkle } from './icons';
import type { FileContentDTO, FileDiffDTO, SearchHit } from '../src/protocol';
type StateMsg = Extract<HostToWebview, { type: 'state' }>;
type ProjectMsg = Extract<HostToWebview, { type: 'project' }>;
type PaletteMode = 'search' | 'commands' | null;

const joinPath = (base: string, rel: string) =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.replace(/\\/g, '/');

export function App() {
  const [state, setState] = useState<StateMsg | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [project, setProject] = useState<ProjectMsg | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docState, dispatchDocs] = useReducer(docsReducer, initialDocs);
  const [files, setFiles] = useState<Map<string, FileContentDTO>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, FileDiffDTO>>(new Map());
  const [paletteMode, setPaletteMode] = useState<PaletteMode>(null);
  const [search, setSearch] = useState<{ root: string; results: SearchHit[] }>({ root: '', results: [] });
  const { hydrate, settings, update } = useSettings();

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'state') { setState(msg); hydrate(msg.settings); }
      else if (msg.type === 'project') setProject(msg);
      else if (msg.type === 'fileContent') setFiles((m) => new Map(m).set(msg.doc.path, msg.doc));
      else if (msg.type === 'fileDiff') setDiffs((m) => new Map(m).set(msg.doc.path, msg.doc));
      else if (msg.type === 'searchResults') setSearch({ root: msg.root, results: msg.results });
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

  // Global shortcuts: Ctrl/Cmd+, settings · Ctrl/Cmd+P file search · +Shift commands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === ',') { e.preventDefault(); setSettingsOpen(true); }
      else if (k === 'p' && e.shiftKey) { e.preventDefault(); setPaletteMode('commands'); }
      else if (k === 'p') { e.preventDefault(); setPaletteMode('search'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // When the file-search palette opens, ask the host to (re)index the active project.
  useEffect(() => {
    if (paletteMode === 'search' && active?.projectPath && search.root !== active.projectPath) {
      post({ type: 'searchFiles', root: active.projectPath, query: '' });
    }
  }, [paletteMode, active?.projectPath, search.root]);

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

  // Palette entries depend on the mode: file/session search vs the command list.
  const paletteEntries: PaletteEntry[] = useMemo(() => {
    if (paletteMode === 'search') {
      const sessionEntries: PaletteEntry[] = sessions.map((s) => ({
        id: `session:${s.id}`,
        title: s.name,
        subtitle: s.projectPath.split(/[\\/]/).filter(Boolean).pop(),
        group: 'Sessions',
        icon: <IconTerminal size={14} />,
        run: () => setActiveId(s.id),
      }));
      const fileEntries: PaletteEntry[] =
        active && search.root === active.projectPath
          ? search.results.map((h) => ({
              id: `file:${h.abs}`,
              title: h.rel,
              group: 'Files',
              icon: <IconDoc size={14} />,
              run: () => openFile(h.abs),
            }))
          : [];
      return [...sessionEntries, ...fileEntries];
    }
    // commands mode
    const cmds: PaletteEntry[] = [
      { id: 'cmd:new', title: 'New session', group: 'Commands', icon: <IconPlus size={14} />, run: () => setNewOpen(true) },
      { id: 'cmd:settings', title: 'Open settings', group: 'Commands', icon: <IconSettings size={14} />, run: () => setSettingsOpen(true) },
      { id: 'cmd:search', title: 'Search files…', group: 'Commands', icon: <IconCommand size={14} />, run: () => setPaletteMode('search') },
    ];
    if (active) {
      cmds.push(
        { id: 'cmd:reveal', title: 'Reveal project in Explorer', group: 'Commands', icon: <IconExternal size={14} />, run: () => post({ type: 'revealInExplorer', path: active.projectPath }) },
        { id: 'cmd:close', title: 'Close active session', group: 'Commands', icon: <IconTerminal size={14} />, run: () => post({ type: 'kill', id: active.id }) },
      );
      if (active.status !== 'running')
        cmds.push({ id: 'cmd:relaunch', title: 'Relaunch active session', group: 'Commands', icon: <IconSparkle size={14} />, run: () => post({ type: 'relaunch', id: active.id }) });
    }
    const themeCmds: PaletteEntry[] = THEMES.map((t) => ({
      id: `theme:${t.id}`,
      title: `Theme: ${t.label}`,
      group: 'Appearance',
      icon: <IconSettings size={14} />,
      run: () => update({ theme: t.id }),
    }));
    return [...cmds, ...themeCmds];
  }, [paletteMode, sessions, active, search, files]);

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
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSearch={() => setPaletteMode('search')}
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {paletteMode && (
        <CommandPalette
          key={paletteMode}
          items={paletteEntries}
          placeholder={paletteMode === 'search' ? 'Search sessions and files…' : 'Type a command…'}
          onClose={() => setPaletteMode(null)}
        />
      )}
    </div>
  );
}
