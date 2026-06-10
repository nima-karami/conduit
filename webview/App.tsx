import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
import { ContextMenu, type MenuState, type MenuItem } from './components/ContextMenu';
import { ConfirmDialog, type ConfirmState } from './components/ConfirmDialog';
import { PanelFrame, type DockHandlers } from './components/PanelFrame';
import { AnimatedBg } from './components/AnimatedBg';
import { BoardView } from './components/BoardView';
import { parseLayout, serializeLayout, centerFacingEdge, type Region } from '../src/layout';
import { moveBefore } from '../src/reorder';
import { docsReducer, initialDocs } from './docs';
import type { OpenDoc } from './docs';
import { useNavHistory } from './useNavHistory';
import type { NavLoc } from '../src/navHistory';
import { SHORTCUT_ACTIONS, matchCombo, effectiveCombo } from './shortcuts';
import { useSettings } from './settings';
import { THEMES } from './themes';
import { IconTerminal, IconDoc, IconCommand, IconSettings, IconPlus, IconExternal, IconSparkle, IconCopy, IconDuplicate, IconPencil, IconTrash, IconClose, IconSidebar, IconBranch, IconBoard } from './icons';
import type { FileContentDTO, FileDiffDTO, SearchHit } from '../src/protocol';
type StateMsg = Extract<HostToWebview, { type: 'state' }>;
type ProjectMsg = Extract<HostToWebview, { type: 'project' }>;
type SettingsTab = 'general' | 'appearance' | 'shortcuts';
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

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
  const [palette, setPalette] = useState<{ initialQuery: string } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [recents, setRecents] = useState<{ kind: 'file' | 'diff'; path: string }[]>([]);
  const [search, setSearch] = useState<{ root: string; results: SearchHit[] }>({ root: '', results: [] });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [splitId, setSplitId] = useState<string | null>(null);
  const dragRegionRef = useRef<Region | null>(null);
  const [overRegion, setOverRegion] = useState<Region | null>(null);
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

  // Auto-switch to a newly created (running) session (when enabled).
  const knownIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const added = sessions.filter((s) => !knownIds.current.has(s.id));
    knownIds.current = new Set(sessions.map((s) => s.id));
    if (!settings.autoSwitchSession) return;
    const newest = added
      .filter((s) => s.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest) setActiveId(newest.id);
  }, [sessions, settings.autoSwitchSession]);

  // Global shortcuts — data-driven from the (rebindable, persisted) bindings.
  const actionMap = useMemo<Record<string, () => void>>(() => ({
    openSearch: () => setPalette({ initialQuery: '' }),
    openCommands: () => setPalette({ initialQuery: '>' }),
    openBoard: () => setBoardOpen(true),
    toggleSidebar: () => setSidebarCollapsed((v) => !v),
    newSession: () => setNewOpen(true),
    openSettings: () => { setSettingsTab('general'); setSettingsOpen(true); },
  }), []);
  const bindingsRef = useRef(settings.shortcuts);
  bindingsRef.current = settings.shortcuts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const action of SHORTCUT_ACTIONS) {
        if (matchCombo(e, effectiveCombo(action, bindingsRef.current)) && actionMap[action.id]) {
          e.preventDefault();
          actionMap[action.id]();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actionMap]);

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

  // When the palette opens, ask the host to (re)index the active project.
  useEffect(() => {
    if (palette && active?.projectPath && search.root !== active.projectPath) {
      post({ type: 'searchFiles', root: active.projectPath, query: '' });
    }
  }, [palette, active?.projectPath, search.root]);

  // Clear a split that became invalid (equals active, or its session stopped).
  useEffect(() => {
    if (splitId && (splitId === activeId || !sessions.some((s) => s.id === splitId && s.status === 'running'))) {
      setSplitId(null);
    }
  }, [splitId, activeId, sessions]);

  const projectData = project && active && project.path === active.projectPath ? project : null;

  const pushRecent = (kind: 'file' | 'diff', path: string) =>
    setRecents((prev) => [{ kind, path }, ...prev.filter((r) => !(r.kind === kind && r.path === path))].slice(0, 10));

  const openFile = (path: string) => {
    if (!files.has(path)) post({ type: 'readFile', path });
    dispatchDocs({ type: 'open', kind: 'file', path });
    pushRecent('file', path);
  };
  const openDiff = (path: string) => {
    post({ type: 'readDiff', path }); // always refresh a diff
    dispatchDocs({ type: 'open', kind: 'diff', path });
    pushRecent('diff', path);
  };

  const openSettingsAt = (tab: SettingsTab) => { setSettingsTab(tab); setSettingsOpen(true); };

  const copyToClipboard = (text: string) => { void navigator.clipboard?.writeText(text); };

  // Close a session — confirm first if it's running and the setting is on.
  const requestKill = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (s && s.status === 'running' && settings.confirmCloseRunning) {
      setConfirm({
        title: 'Close session?',
        message: `"${s.name}" is running. Closing it will terminate its terminal.`,
        confirmLabel: 'Close session',
        danger: true,
        onConfirm: () => post({ type: 'kill', id }),
      });
    } else {
      post({ type: 'kill', id });
    }
  };

  const onSessionContextMenu = (e: React.MouseEvent, s: Session) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Reveal in Explorer', icon: <IconExternal size={14} />, onClick: () => post({ type: 'revealInExplorer', path: s.projectPath }) },
        { label: 'Duplicate session', icon: <IconDuplicate size={14} />, onClick: () => post({ type: 'duplicate', id: s.id }) },
        ...(s.status === 'running' && s.id !== activeId
          ? [{ label: 'Open in split pane', icon: <IconSidebar size={14} />, onClick: () => setSplitId(s.id) }]
          : []),
        ...(s.status !== 'running'
          ? [{ label: 'Relaunch', icon: <IconSparkle size={14} />, onClick: () => post({ type: 'relaunch' as const, id: s.id }) }]
          : []),
        { label: 'Copy path', icon: <IconCopy size={14} />, separatorBefore: true, onClick: () => copyToClipboard(s.projectPath) },
        { label: 'Copy name', icon: <IconCopy size={14} />, onClick: () => copyToClipboard(s.name) },
        { label: 'Rename', icon: <IconPencil size={14} />, onClick: () => { setActiveId(s.id); setRenamingId(s.id); } },
        { label: 'Close session', icon: <IconTrash size={14} />, danger: true, separatorBefore: true, onClick: () => requestKill(s.id) },
      ],
    });
  };

  const onTabContextMenu = (e: React.MouseEvent, doc: OpenDoc) => {
    e.preventDefault();
    const others = docState.docs.filter((d) => d.id !== doc.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Close', icon: <IconClose size={14} />, onClick: () => dispatchDocs({ type: 'close', id: doc.id }) },
        { label: 'Close others', onClick: () => others.forEach((d) => dispatchDocs({ type: 'close', id: d.id })), disabled: others.length === 0 },
        { label: 'Close all', onClick: () => docState.docs.forEach((d) => dispatchDocs({ type: 'close', id: d.id })), disabled: docState.docs.length === 0 },
        { label: 'Copy path', icon: <IconCopy size={14} />, separatorBefore: true, onClick: () => copyToClipboard(doc.path) },
        { label: 'Copy file name', icon: <IconCopy size={14} />, onClick: () => copyToClipboard(baseName(doc.path)) },
        { label: 'Reveal in Explorer', icon: <IconExternal size={14} />, onClick: () => post({ type: 'revealInExplorer', path: doc.path }) },
      ],
    });
  };

  const onFileContextMenu = (e: React.MouseEvent, node: { path: string; kind: 'dir' | 'file' }) => {
    e.preventDefault();
    const rel = active?.projectPath
      ? node.path.replace(active.projectPath.replace(/[\\/]+$/, ''), '').replace(/^[\\/]+/, '')
      : node.path;
    const items: MenuItem[] = [];
    if (node.kind === 'file') items.push({ label: 'Open', icon: <IconDoc size={14} />, onClick: () => openFile(node.path) });
    items.push(
      { label: 'Reveal in Explorer', icon: <IconExternal size={14} />, onClick: () => post({ type: 'revealInExplorer', path: node.path }) },
      { label: 'Copy path', icon: <IconCopy size={14} />, separatorBefore: true, onClick: () => copyToClipboard(node.path) },
      { label: 'Copy relative path', icon: <IconCopy size={14} />, onClick: () => copyToClipboard(rel) },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onChangeContextMenu = (e: React.MouseEvent, rel: string) => {
    e.preventDefault();
    if (!active?.projectPath) return;
    const abs = joinPath(active.projectPath, rel);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open diff', icon: <IconBranch size={14} />, onClick: () => openDiff(abs) },
        { label: 'Open file', icon: <IconDoc size={14} />, onClick: () => openFile(abs) },
        { label: 'Reveal in Explorer', icon: <IconExternal size={14} />, separatorBefore: true, onClick: () => post({ type: 'revealInExplorer', path: abs }) },
        { label: 'Copy path', icon: <IconCopy size={14} />, onClick: () => copyToClipboard(abs) },
      ],
    });
  };

  // Back/forward navigation across visited views (session terminal / doc tabs).
  const applyNav = useCallback((l: NavLoc) => {
    setActiveId(l.sessionId);
    const exists = l.docId !== null && docState.docs.some((d) => d.id === l.docId);
    dispatchDocs({ type: 'activate', id: exists ? l.docId : null });
  }, [docState.docs]);
  const { goBack, goForward, canBack, canForward } = useNavHistory(
    { sessionId: activeId, docId: docState.activeId },
    applyNav,
  );

  // Default palette set: open sessions + files of the active project.
  const searchItems: PaletteEntry[] = useMemo(() => {
    const sessionEntries: PaletteEntry[] = sessions.map((s) => ({
      id: `session:${s.id}`,
      title: s.name,
      subtitle: baseName(s.projectPath),
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
  }, [sessions, active, search]);

  // Recently opened documents (shown when the query is empty).
  const recentItems: PaletteEntry[] = useMemo(
    () => recents.map((r) => ({
      id: `recent:${r.kind}:${r.path}`,
      title: baseName(r.path),
      subtitle: r.kind === 'diff' ? 'diff' : undefined,
      group: 'Recent',
      icon: <IconDoc size={14} />,
      run: () => (r.kind === 'file' ? openFile(r.path) : openDiff(r.path)),
    })),
    [recents],
  );

  // Command set (accessed via the `>` prefix).
  const commandItems: PaletteEntry[] = useMemo(() => {
    const cmds: PaletteEntry[] = [
      { id: 'cmd:new', title: 'New session', group: 'Commands', icon: <IconPlus size={14} />, run: () => setNewOpen(true) },
      { id: 'cmd:board', title: 'Open feature board', group: 'Commands', icon: <IconBoard size={14} />, run: () => setBoardOpen(true) },
      { id: 'cmd:toggleSidebar', title: 'Toggle sidebar', group: 'Commands', icon: <IconSidebar size={14} />, run: () => setSidebarCollapsed((v) => !v) },
      { id: 'cmd:back', title: 'Go back', group: 'Commands', icon: <IconCommand size={14} />, run: goBack },
      { id: 'cmd:forward', title: 'Go forward', group: 'Commands', icon: <IconCommand size={14} />, run: goForward },
      { id: 'cmd:reduceMotion', title: settings.reduceMotion ? 'Reduce motion: off' : 'Reduce motion: on', group: 'Commands', icon: <IconSparkle size={14} />, run: () => update({ reduceMotion: !settings.reduceMotion }) },
      { id: 'cmd:cycleTheme', title: 'Cycle theme', group: 'Commands', icon: <IconSettings size={14} />, run: () => {
        const i = THEMES.findIndex((t) => t.id === settings.theme);
        update({ theme: THEMES[(i + 1) % THEMES.length].id });
      } },
    ];
    if (active) {
      cmds.push(
        { id: 'cmd:reveal', title: 'Reveal project in Explorer', group: 'Commands', icon: <IconExternal size={14} />, run: () => post({ type: 'revealInExplorer', path: active.projectPath }) },
        { id: 'cmd:close', title: 'Close active session', group: 'Commands', icon: <IconTrash size={14} />, run: () => requestKill(active.id) },
      );
      if (active.status !== 'running')
        cmds.push({ id: 'cmd:relaunch', title: 'Relaunch active session', group: 'Commands', icon: <IconSparkle size={14} />, run: () => post({ type: 'relaunch', id: active.id }) });
    }
    const activeDoc = docState.docs.find((d) => d.id === docState.activeId);
    if (activeDoc) {
      cmds.push(
        { id: 'cmd:revealFile', title: 'Reveal active file in Explorer', group: 'Commands', icon: <IconExternal size={14} />, run: () => post({ type: 'revealInExplorer', path: activeDoc.path }) },
        { id: 'cmd:copyFile', title: 'Copy active file path', group: 'Commands', icon: <IconCopy size={14} />, run: () => copyToClipboard(activeDoc.path) },
        { id: 'cmd:closeOthers', title: 'Close other tabs', group: 'Commands', icon: <IconClose size={14} />, run: () => docState.docs.filter((d) => d.id !== activeDoc.id).forEach((d) => dispatchDocs({ type: 'close', id: d.id })) },
      );
    }
    const settingsCmds: PaletteEntry[] = [
      { id: 'set:general', title: 'Open Settings: General', group: 'Settings', icon: <IconSettings size={14} />, run: () => openSettingsAt('general') },
      { id: 'set:appearance', title: 'Open Settings: Appearance', group: 'Settings', icon: <IconSettings size={14} />, run: () => openSettingsAt('appearance') },
      { id: 'set:shortcuts', title: 'Open Settings: Shortcuts', group: 'Settings', icon: <IconSettings size={14} />, run: () => openSettingsAt('shortcuts') },
    ];
    const themeCmds: PaletteEntry[] = THEMES.map((t) => ({
      id: `theme:${t.id}`,
      title: `Theme: ${t.label}`,
      group: 'Appearance',
      icon: <IconSettings size={14} />,
      run: () => update({ theme: t.id }),
    }));
    const sessionSwitch: PaletteEntry[] = sessions.map((s) => ({
      id: `goto:${s.id}`,
      title: `Switch to: ${s.name}`,
      group: 'Sessions',
      icon: <IconTerminal size={14} />,
      run: () => setActiveId(s.id),
    }));
    const splitCmds: PaletteEntry[] = sessions
      .filter((s) => s.status === 'running' && s.id !== activeId)
      .map((s) => ({
        id: `split:${s.id}`,
        title: `Split with: ${s.name}`,
        group: 'Sessions',
        icon: <IconSidebar size={14} />,
        run: () => setSplitId(s.id),
      }));
    if (splitId) splitCmds.push({ id: 'split:close', title: 'Close split pane', group: 'Sessions', icon: <IconClose size={14} />, run: () => setSplitId(null) });
    return [...cmds, ...settingsCmds, ...themeCmds, ...sessionSwitch, ...splitCmds];
  }, [active, sessions, settings, docState, goBack, goForward, activeId, splitId]);

  // ---- Dockable layout: render the three regions in the persisted order ----
  const order = parseLayout(settings.layout);
  const visibleOrder = sidebarCollapsed ? order.filter((r) => r !== 'sessions') : order;
  const resetDock = () => { dragRegionRef.current = null; setOverRegion(null); };
  const dockHandlers = (region: Region): DockHandlers => ({
    isOver: overRegion === region,
    onDragStart: () => { dragRegionRef.current = region; },
    onDragEnd: resetDock,
    onDragOver: (e) => { const d = dragRegionRef.current; if (d && d !== region) { e.preventDefault(); setOverRegion(region); } },
    onDrop: () => {
      const d = dragRegionRef.current;
      if (d && d !== region) update({ layout: serializeLayout(moveBefore(order, d, region) as Region[]) });
      resetDock();
    },
  });
  const commitWidth = (region: Region, w: number) => update(region === 'sessions' ? { leftWidth: w } : { rightWidth: w });

  const renderRegion = (region: Region) => {
    if (region === 'center') {
      return (
        <CenterPane
          key="center"
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
          onTabContextMenu={onTabContextMenu}
          onReorderDoc={(dragId, targetId) => dispatchDocs({ type: 'reorder', dragId, targetId })}
          dock={dockHandlers('center')}
          splitId={splitId}
          onCloseSplit={() => setSplitId(null)}
        />
      );
    }
    if (region === 'sessions') {
      return (
        <PanelFrame key="sessions" region="sessions" title="Sessions" widthVar="--left-w"
          edge={centerFacingEdge(visibleOrder, 'sessions')} onWidthCommit={(w) => commitWidth('sessions', w)} dock={dockHandlers('sessions')}>
          <Sidebar
            groups={state?.groups ?? []}
            agents={agents}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={() => setNewOpen(true)}
            onKill={requestKill}
            onRename={(id, name) => post({ type: 'rename', id, name })}
            onRelaunch={(id) => post({ type: 'relaunch', id })}
            onOpenSettings={() => openSettingsAt('general')}
            onOpenSearch={() => setPalette({ initialQuery: '' })}
            onContextMenu={onSessionContextMenu}
            renamingId={renamingId}
            onSetRenaming={(id) => setRenamingId(id ?? undefined)}
            onReorderSessions={(o) => post({ type: 'reorderSessions', order: o })}
          />
        </PanelFrame>
      );
    }
    return (
      <PanelFrame key="explorer" region="explorer" title="Explorer" widthVar="--right-w"
        edge={centerFacingEdge(visibleOrder, 'explorer')} onWidthCommit={(w) => commitWidth('explorer', w)} dock={dockHandlers('explorer')}>
        <RightPane
          projectPath={active?.projectPath}
          changes={projectData?.changes ?? []}
          onOpenFile={openFile}
          onOpenDiff={(rel) => active?.projectPath && openDiff(joinPath(active.projectPath, rel))}
          onFileContextMenu={onFileContextMenu}
          onChangeContextMenu={onChangeContextMenu}
        />
      </PanelFrame>
    );
  };

  return (
    <div className="shell">
      <AnimatedBg />
      <TopBar
        project={activeProject ?? 'Agent Deck'}
        session={active?.name ?? 'No session'}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        sidebarCollapsed={sidebarCollapsed}
        onBack={goBack}
        onForward={goForward}
        canBack={canBack}
        canForward={canForward}
        onOpenBoard={() => setBoardOpen(true)}
      />
      <div className="workbench">
        {visibleOrder.map(renderRegion)}
      </div>
      {newOpen && (
        <NewSessionModal
          repos={state?.repos ?? []}
          agents={agents}
          onClose={() => setNewOpen(false)}
          onOpen={(path, agentId) => { post({ type: 'openRepo', path, agentId }); setNewOpen(false); }}
          onBrowse={(agentId) => { post({ type: 'browseRepo', agentId }); setNewOpen(false); }}
        />
      )}
      {settingsOpen && <SettingsModal agents={agents} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />}
      {palette && (
        <CommandPalette
          key={palette.initialQuery}
          items={searchItems}
          commandItems={commandItems}
          recentItems={recentItems}
          initialQuery={palette.initialQuery}
          placeholder="Search files & sessions, or type > for commands…"
          onClose={() => setPalette(null)}
        />
      )}
      {boardOpen && <BoardView onClose={() => setBoardOpen(false)} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
