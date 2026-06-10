import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { DEFAULT_SETTINGS } from '../src/settings';
import { seedBoard } from '../src/board';
import { seedArchitecture, type ArchDoc } from '../src/architecture';
import { mockAgents, mockGroups, mockRepos, changes as mockChanges, files as mockFiles, customizations as mockCust, mockDir, mockFileText, mockMarkdown, mockSearch } from './mock';

export interface WinControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
}

interface HostBridge {
  post(msg: WebviewToHost): void;
  subscribe(cb: (msg: HostToWebview) => void): () => void;
  win: WinControls;
}

declare global {
  interface Window {
    agentDeck?: HostBridge;
  }
}

type Listener = (msg: HostToWebview) => void;

const listeners = new Set<Listener>();
// Messages can arrive before React mounts and subscribes (the host replies to
// our `ready` fast). Buffer anything that has no listener yet and flush it to the
// first subscriber, so the initial `state`/`project` is never dropped.
const pending: HostToWebview[] = [];
function emit(msg: HostToWebview) {
  if (listeners.size === 0) {
    pending.push(msg);
    return;
  }
  listeners.forEach((l) => l(msg));
}

/** The Electron main-process bridge (exposed via preload), or undefined in the browser preview. */
const host: HostBridge | undefined = window.agentDeck;

/** True inside the desktop app (real PTY available); false in the browser preview. */
export const isHosted = !!host;

/** Native window controls (minimize/maximize/close), or undefined in the preview. */
export const win: WinControls | undefined = host?.win;

if (host) host.subscribe((msg) => emit(msg));

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  if (pending.length) pending.splice(0).forEach((m) => cb(m));
  return () => listeners.delete(cb);
}

export function post(msg: WebviewToHost): void {
  if (host) {
    host.post(msg);
  } else {
    mockHost(msg);
  }
}

/** Send a diagnostic line to the host's log. */
export function logToHost(message: string): void {
  post({ type: 'log', message });
}

// Surface uncaught webview errors into the host log instead of the (hidden) console.
if (host) {
  window.addEventListener('error', (e) => {
    logToHost(`window error: ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    logToHost(`unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`);
  });
}

// ----- Browser-preview fallback: a tiny fake shell so the terminal is visible
// in screenshots without a real desktop host. Never runs inside the app.
const lineBuf = new Map<string, string>();
let mockBoard = seedBoard();
let mockArch: ArchDoc = seedArchitecture('nextjs-portfolio');

// Flat ordered session list (the global manual order), mirroring the host's Map.
const allMockSessions = mockGroups.flatMap((g) => g.sessions);
let mockOrder = allMockSessions.map((s) => s.id);

function mockState() {
  const byId = new Map(allMockSessions.map((s) => [s.id, s]));
  const sessions = mockOrder.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  const groupsMap = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const arr = groupsMap.get(s.projectPath) ?? [];
    arr.push(s);
    groupsMap.set(s.projectPath, arr);
  }
  const groups = [...groupsMap.entries()].map(([projectPath, sess]) => ({ projectPath, sessions: sess }));
  return { type: 'state' as const, agents: mockAgents, groups, sessions, repos: mockRepos, settings: DEFAULT_SETTINGS };
}

function mockHost(msg: WebviewToHost) {
  if (msg.type === 'ready') {
    setTimeout(() => emit(mockState()), 20);
    return;
  }
  if (msg.type === 'searchFiles') {
    setTimeout(() => emit({ type: 'searchResults', root: msg.root, results: mockSearch }), 15);
    return;
  }
  if (msg.type === 'requestBoard') {
    setTimeout(() => emit({ type: 'board', board: mockBoard }), 15);
    return;
  }
  if (msg.type === 'indexProject') {
    setTimeout(() => emit({ type: 'projectFiles', root: msg.root, files: [] }), 15);
    return;
  }
  if (msg.type === 'updateBoard') {
    mockBoard = msg.board; // keep preview in sync within the session
    return;
  }
  if (msg.type === 'requestArchitecture') {
    setTimeout(() => emit({ type: 'architecture', path: msg.path, doc: mockArch }), 15);
    return;
  }
  if (msg.type === 'updateArchitecture') {
    mockArch = msg.doc; // keep preview in sync within the session
    return;
  }
  if (msg.type === 'updateSettings' || msg.type === 'revealInExplorer' || msg.type === 'duplicate') {
    return; // no-op in preview
  }
  if (msg.type === 'reorderSessions') {
    // Apply the new global order (unknown ids ignored, missing appended) and re-emit.
    const known = msg.order.filter((id) => mockOrder.includes(id));
    mockOrder = [...known, ...mockOrder.filter((id) => !known.includes(id))];
    setTimeout(() => emit(mockState()), 10);
    return;
  }
  if (msg.type === 'requestProject') {
    setTimeout(
      () =>
        emit({
          type: 'project',
          path: msg.path,
          changes: mockChanges,
          files: mockFiles,
          customizations: mockCust.map((c) => ({ id: c.id, count: c.count ?? 0 })),
        }),
      20,
    );
    return;
  }
  if (msg.type === 'readDir') {
    setTimeout(() => emit({ type: 'dirEntries', path: msg.path, entries: mockDir }), 15);
    return;
  }
  if (msg.type === 'readFile') {
    const isMd = msg.path.endsWith('.md');
    setTimeout(
      () => emit({
        type: 'fileContent',
        doc: { path: msg.path, content: isMd ? mockMarkdown : mockFileText, language: isMd ? 'markdown' : 'typescript', truncated: false, binary: false },
      }),
      15,
    );
    return;
  }
  if (msg.type === 'readDiff') {
    setTimeout(
      () => emit({ type: 'fileDiff', doc: { path: msg.path, head: 'const a = 1;\n', work: 'const a = 2;\n', binary: false } }),
      15,
    );
    return;
  }
  if (msg.type === 'term:start') {
    const id = msg.sessionId;
    lineBuf.set(id, '');
    setTimeout(() => {
      emit({
        type: 'term:data',
        sessionId: id,
        data:
          '\x1b[38;5;209m✷ Claude Code\x1b[0m \x1b[2m(preview — fake shell)\x1b[0m\r\n' +
          '\x1b[2mType something and press Enter. In the app this is a real PTY.\x1b[0m\r\n\r\n' +
          '\x1b[38;5;209m❯\x1b[0m ',
      });
    }, 60);
  } else if (msg.type === 'term:input') {
    const id = msg.sessionId;
    const ch = msg.data;
    if (ch === '\r') {
      const cmd = (lineBuf.get(id) ?? '').trim();
      lineBuf.set(id, '');
      const out = cmd ? `\r\n\x1b[2myou typed:\x1b[0m ${cmd}\r\n` : '\r\n';
      emit({ type: 'term:data', sessionId: id, data: `${out}\x1b[38;5;209m❯\x1b[0m ` });
    } else if (ch === '\x7f') {
      const cur = lineBuf.get(id) ?? '';
      lineBuf.set(id, cur.slice(0, -1));
      emit({ type: 'term:data', sessionId: id, data: '\b \b' });
    } else {
      lineBuf.set(id, (lineBuf.get(id) ?? '') + ch);
      emit({ type: 'term:data', sessionId: id, data: ch });
    }
  }
}
