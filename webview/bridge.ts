import { type ArchDoc, seedArchitecture } from '../src/architecture';
import { type BoardData, seedBoard } from '../src/board';
import { type ContentSearchDeps, type Dirent, searchContent } from '../src/content-search';
import type { DndResult } from '../src/fs-dnd';
import type { FsMutationRequest, MutationResult } from '../src/fs-mutations';
import type { GitActionRequest, GitActionResult } from '../src/git-actions';
import type { WriteResult } from '../src/path-guard';
import {
  appendQueueEntry,
  buildQueueEntry,
  emptyPipelineConfig,
  type PipelineConfig,
  type PipelineQueue,
} from '../src/pipeline';
import type { DirEntryDTO, HostToWebview, WebviewToHost } from '../src/protocol';
import { summarizeQueue } from '../src/queue-summary';
import { DEFAULT_SETTINGS } from '../src/settings';
import {
  mockAgents,
  changes as mockChanges,
  customizations as mockCust,
  mockDiffs,
  mockDir,
  files as mockFiles,
  mockFileText,
  mockGroups,
  mockMarkdown,
  mockRepos,
  mockSearch,
  mockSearchCorpus,
} from './mock';

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
  openExternal(url: string): void;
  writeFile(path: string, content: string): Promise<WriteResult>;
  gitAction(req: GitActionRequest): Promise<GitActionResult>;
  fsMutate(req: FsMutationRequest): Promise<MutationResult>;
  fsMove(from: string, to: string): Promise<DndResult>;
  fsCopy(from: string, to: string): Promise<DndResult>;
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
  listeners.forEach((l) => {
    l(msg);
  });
}

/** The Electron main-process bridge (exposed via preload), or undefined in the browser preview. */
const host: HostBridge | undefined = window.agentDeck;

/** True inside the desktop app (real PTY available); false in the browser preview. */
const _isHosted = !!host;

/** Native window controls (minimize/maximize/close), or undefined in the preview. */
export const win: WinControls | undefined = host?.win;

if (host) host.subscribe((msg) => emit(msg));

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  if (pending.length)
    pending.splice(0).forEach((m) => {
      cb(m);
    });
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

/**
 * Save a file buffer back to disk via the host bridge. Degrades SAFELY in the
 * browser preview: when `window.agentDeck` is absent there is no filesystem to
 * write to, so this is a guarded no-op that resolves to a clear "no host" rejection
 * (never throws). Callers treat a non-ok result by keeping the buffer dirty, so a
 * preview save simply leaves the dot in place instead of pretending to persist.
 */
export function writeFile(path: string, content: string): Promise<WriteResult> {
  if (host) return host.writeFile(path, content);
  return Promise.resolve({ ok: false, error: 'No host: cannot save in the browser preview.' });
}

/**
 * Run a git action via the host bridge. In the browser preview (`window.agentDeck`
 * absent) there is no git to drive, so this resolves `{ ok: true }` and the caller's
 * follow-up `requestProject` simply reloads the unchanged mock list — the actions
 * no-op gracefully and the sections still render for screenshots.
 */
export function gitAction(req: GitActionRequest): Promise<GitActionResult> {
  if (host) return host.gitAction(req);
  return Promise.resolve({ ok: true });
}

/**
 * Create / rename / delete a file or folder via the host bridge. In the browser
 * preview (`window.agentDeck` absent) there is no filesystem, so this drives an
 * in-memory mock directory store (see `mockMutate`) so the inline-edit UX —
 * draft rows, commit/cancel, refresh, reveal — is fully drivable for screenshots
 * without a real host.
 */
export function fsMutate(req: FsMutationRequest): Promise<MutationResult> {
  if (host) return host.fsMutate(req);
  return Promise.resolve(mockMutate(req));
}

/**
 * Move a file or folder via the host bridge (drag-and-drop, D5). In the browser
 * preview (`window.agentDeck` absent) there is no filesystem — this is a safe
 * no-op that resolves to a clear "no host" rejection (never throws). The caller
 * can still update its UI state optimistically if desired; the tree will refresh
 * on re-focus regardless.
 */
export function fsDndMove(from: string, to: string): Promise<DndResult> {
  if (host) return host.fsMove(from, to);
  return Promise.resolve({ ok: false, error: 'No host: cannot move in the browser preview.' });
}

/**
 * Copy a file or folder via the host bridge (drag-and-drop with Ctrl, D5). In
 * the browser preview (`window.agentDeck` absent) this is a safe no-op.
 */
export function fsDndCopy(from: string, to: string): Promise<DndResult> {
  if (host) return host.fsCopy(from, to);
  return Promise.resolve({ ok: false, error: 'No host: cannot copy in the browser preview.' });
}

/** True when a real host filesystem is available to save to (false in preview). */
export const canSave = _isHosted;

/**
 * Open an external URL in the user's real browser via the host bridge.
 * Returns true if the host handled it; false in the plain-browser preview
 * (where `window.agentDeck` is absent) so callers can fall back to a normal
 * anchor instead of a destructive in-window navigation.
 */
export function openExternal(url: string): boolean {
  if (host) {
    host.openExternal(url);
    return true;
  }
  return false;
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
// Preview-only in-memory spec store (cardId → markdown). Lets the board's "Open spec"
// affordance + has-spec indicator work in the plain-browser preview without a real host.
const mockSpecs = new Map<string, string>();
let mockArch: ArchDoc = seedArchitecture('nextjs-portfolio');

// Preview-only agent PROPOSALS (N1). A demo `*.proposed.json` so the banner + diff +
// accept/reject flow is demonstrable in the plain-browser preview without a real agent or
// host. Built lazily from the current mock board/arch so the diff is meaningful; cleared
// on accept (after applying to the canonical mock) or reject. `undefined` = "not built
// yet" (seed the demo on first request); `null` = "explicitly cleared".
let mockBoardProposal: BoardData | null | undefined;
let mockArchProposal: ArchDoc | null | undefined;

/** A demo board proposal: advances one card a column, edits another, and adds a new card —
 *  so the banner shows moved + edited + added at once. */
function buildBoardProposal(): BoardData {
  const cards = mockBoard.cards.map((c) => ({ ...c }));
  if (cards[0]) cards[0] = { ...cards[0], stage: 'building' };
  const wishIdx = cards.findIndex((c) => c.stage === 'wishlist');
  if (wishIdx >= 0) cards[wishIdx] = { ...cards[wishIdx], notes: 'Agent: scoped + ready to plan.' };
  cards.push({
    id: 'card-proposed-demo',
    title: 'Proposed: telemetry opt-in',
    notes: 'Suggested by the overnight agent.',
    stage: 'wishlist',
  });
  return { ...mockBoard, cards };
}

/** A demo architecture proposal: renames the root, edits a node, and adds a node. */
function buildArchProposal(): ArchDoc {
  const root = mockArch.graphs[mockArch.rootGraph];
  if (!root) return mockArch;
  const nodes = root.nodes.map((n) => ({ ...n }));
  if (nodes[0]) nodes[0] = { ...nodes[0], description: 'Agent: holds no source of truth.' };
  nodes.push({
    id: 'node-proposed-demo',
    title: 'Proposed: Telemetry',
    subtitle: 'opt-in metrics',
    kind: 'service' as const,
    x: 620,
    y: 180,
  });
  return {
    ...mockArch,
    graphs: {
      ...mockArch.graphs,
      [root.id]: { ...root, title: `${root.title} (proposed)`, nodes },
    },
  };
}

function currentBoardProposal(): BoardData | null {
  if (mockBoardProposal === undefined) mockBoardProposal = buildBoardProposal();
  return mockBoardProposal;
}

function currentArchProposal(): ArchDoc | null {
  if (mockArchProposal === undefined) mockArchProposal = buildArchProposal();
  return mockArchProposal;
}
// Preview-only pipeline config + transition queue (G4/N3). Lets the Pipeline panel + the
// on-move skill surfacing and the queue-depth header badge work in the preview.
let mockPipeline: PipelineConfig = emptyPipelineConfig();
// Alternates each manual `updateCheck` in the preview between "already up to date" and a
// full update flow, so both the Settings → About states and the sidebar card are
// demonstrable. Starts up-to-date (the common real case the polished UX targets).
let mockUpdateFlips = 0;
// Seed the mock queue with demo entries (N3) so the header badge + popover are visible
// without needing a real project or pipeline config.
const MOCK_NOW = Date.now();
let mockQueue: PipelineQueue = {
  version: 1,
  entries: [
    buildQueueEntry(
      { id: 'card-f3', title: 'Go-to-definition' },
      'planning',
      'building',
      'writing-plans',
      MOCK_NOW - 120_000,
      'q-demo-1',
    ),
    buildQueueEntry(
      { id: 'card-f1', title: 'Tab bar' },
      'wishlist',
      'planning',
      'feature-spec',
      MOCK_NOW - 60_000,
      'q-demo-2',
    ),
    buildQueueEntry(
      { id: 'card-n3', title: 'Orchestration status' },
      'planning',
      'building',
      'writing-plans',
      MOCK_NOW - 5_000,
      'q-demo-3',
    ),
  ],
};

// Preview-only in-memory directory store for the Explorer file-tree mutations (L2).
// Keyed by absolute dir path → its immediate entries. Seeded lazily from `mockDir` for
// any unseen directory so the tree still renders; create/rename/delete mutate this map
// so the inline-edit UX round-trips (refresh re-reads from here) without a real fs.
const mockDirs = new Map<string, DirEntryDTO[]>();
const dirOf = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
const nameOf = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;
const sortDir = (e: DirEntryDTO[]) =>
  [...e].sort((a, b) =>
    a.kind !== b.kind
      ? a.kind === 'dir'
        ? -1
        : 1
      : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );

function mockDirEntries(p: string): DirEntryDTO[] {
  const existing = mockDirs.get(p);
  if (existing) return existing;
  const seeded = sortDir(mockDir.map((e) => ({ ...e })));
  mockDirs.set(p, seeded);
  return seeded;
}

/** In-memory analogue of src/fs-mutations against the preview dir store. */
function mockMutate(req: FsMutationRequest): MutationResult {
  const target = req.op === 'rename' ? req.to : req.path;
  const parent = dirOf(target);
  const entries = mockDirEntries(parent);
  if (req.op === 'createFile' || req.op === 'createDir') {
    const name = nameOf(target);
    if (entries.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: 'A file or folder with that name already exists.' };
    }
    mockDirs.set(
      parent,
      sortDir([...entries, { name, kind: req.op === 'createDir' ? 'dir' : 'file' }]),
    );
    return { ok: true, path: target };
  }
  if (req.op === 'rename') {
    const fromName = nameOf(req.from);
    const toName = nameOf(req.to);
    const node = entries.find((e) => e.name === fromName);
    if (!node) return { ok: false, error: 'Source no longer exists.' };
    if (entries.some((e) => e.name.toLowerCase() === toName.toLowerCase() && e.name !== fromName)) {
      return { ok: false, error: 'A file or folder with that name already exists.' };
    }
    mockDirs.set(
      parent,
      sortDir(entries.map((e) => (e.name === fromName ? { ...e, name: toName } : e))),
    );
    return { ok: true, path: req.to };
  }
  // remove / removePermanent
  const name = nameOf(target);
  mockDirs.set(
    parent,
    entries.filter((e) => e.name !== name),
  );
  return { ok: true, path: target };
}

// Flat ordered session list (the global manual order), mirroring the host's Map.
// Mutable copy so the preview can drop sessions on `kill` (close / close all /
// close others) and re-emit a smaller list — mirroring the host's PtyHost kill →
// SessionManager.remove → state re-broadcast round-trip, minus the real pty.
const allMockSessions = [...mockGroups.flatMap((g) => g.sessions)];
let mockOrder = allMockSessions.map((s) => s.id);

function mockState() {
  const byId = new Map(allMockSessions.map((s) => [s.id, s]));
  const sessions = mockOrder
    .map((id) => byId.get(id))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const groupsMap = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const arr = groupsMap.get(s.projectPath) ?? [];
    arr.push(s);
    groupsMap.set(s.projectPath, arr);
  }
  const groups = [...groupsMap.entries()].map(([projectPath, sess]) => ({
    projectPath,
    sessions: sess,
  }));
  return {
    type: 'state' as const,
    agents: mockAgents,
    groups,
    sessions,
    repos: mockRepos,
    settings: DEFAULT_SETTINGS,
    about: {
      version: '0.1.0',
      author: 'Nima Karami',
      electronVersion: '42.x',
      nodeVersion: '22.x',
      chromeVersion: '130.x',
    },
  };
}

// Preview-only content-search deps: an in-memory fs over `mockSearchCorpus`, rooted at a
// synthetic path. Lets the bridge run the REAL pure search core so the toggles work in the
// browser preview (no host). Directory structure is derived from the corpus' rel paths.
const MOCK_SEARCH_ROOT = 'G:/awby/projects/nextjs-portfolio';
function mockContentSearchDeps(): ContentSearchDeps {
  // dir(absDir) → child entries; lazily materialise the tree from the corpus keys.
  const dirs = new Map<string, Map<string, 'dir' | 'file'>>();
  const ensure = (abs: string) => {
    let m = dirs.get(abs);
    if (!m) {
      m = new Map();
      dirs.set(abs, m);
    }
    return m;
  };
  ensure(MOCK_SEARCH_ROOT);
  for (const rel of Object.keys(mockSearchCorpus)) {
    const parts = rel.split('/');
    let cur = MOCK_SEARCH_ROOT;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      ensure(cur).set(name, isFile ? 'file' : 'dir');
      cur = `${cur}/${name}`;
    }
  }
  const dirent = (name: string, kind: 'dir' | 'file'): Dirent => ({
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  });
  return {
    readdir: (p) => {
      const m = dirs.get(p.replace(/\/+$/, ''));
      if (!m) throw new Error(`ENOENT ${p}`);
      return [...m.entries()].map(([name, kind]) => dirent(name, kind));
    },
    readFile: (p) => {
      const rel = p.replace(`${MOCK_SEARCH_ROOT}/`, '');
      const content = mockSearchCorpus[rel];
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      const bytes = [...new TextEncoder().encode(content)] as number[] & {
        toString(enc: 'utf8'): string;
      };
      bytes.toString = ((enc: string) => (enc === 'utf8' ? content : '')) as typeof bytes.toString;
      return bytes;
    },
    now: () => Date.now(),
  };
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
  if (msg.type === 'contentSearch') {
    // Run the REAL pure core against the in-memory corpus so the toggles work in preview.
    const r = searchContent(MOCK_SEARCH_ROOT, msg.query, mockContentSearchDeps());
    setTimeout(
      () =>
        emit({
          type: 'contentSearchResults',
          requestId: msg.requestId,
          root: msg.root,
          results: r.files,
          truncated: r.truncated,
          error: r.error,
        }),
      15,
    );
    return;
  }
  if (msg.type === 'requestBoard') {
    setTimeout(() => {
      emit({ type: 'board', path: msg.path, board: mockBoard });
      emit({ type: 'specsList', path: msg.path, cardIds: [...mockSpecs.keys()] });
      // Surface the demo board proposal (N1) so the banner is demonstrable in preview.
      emit({ type: 'proposal', path: msg.path, kind: 'board', proposed: currentBoardProposal() });
      // Surface the pipeline queue summary (N3): depth badge + popover entries.
      emit({ type: 'pipelineQueue', path: msg.path, summary: summarizeQueue(mockQueue.entries) });
    }, 15);
    return;
  }
  if (msg.type === 'requestSpec') {
    const content = mockSpecs.get(msg.cardId);
    setTimeout(
      () =>
        emit({
          type: 'spec',
          path: msg.path,
          cardId: msg.cardId,
          content: content ?? '',
          exists: content !== undefined,
        }),
      15,
    );
    return;
  }
  if (msg.type === 'saveSpec') {
    mockSpecs.set(msg.cardId, msg.content);
    setTimeout(
      () => emit({ type: 'specsList', path: msg.path, cardIds: [...mockSpecs.keys()] }),
      5,
    );
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
    setTimeout(() => {
      emit({ type: 'architecture', path: msg.path, doc: mockArch });
      emit({
        type: 'proposal',
        path: msg.path,
        kind: 'architecture',
        proposed: currentArchProposal(),
      });
    }, 15);
    return;
  }
  if (msg.type === 'requestProposal') {
    setTimeout(() => {
      if (msg.kind === 'board')
        emit({ type: 'proposal', path: msg.path, kind: 'board', proposed: currentBoardProposal() });
      else
        emit({
          type: 'proposal',
          path: msg.path,
          kind: 'architecture',
          proposed: currentArchProposal(),
        });
    }, 10);
    return;
  }
  if (msg.type === 'acceptProposal') {
    // Apply the proposed doc to the canonical mock, clear the proposal, re-emit both.
    setTimeout(() => {
      if (msg.kind === 'board') {
        const proposed = currentBoardProposal();
        if (proposed) mockBoard = proposed;
        mockBoardProposal = null;
        emit({ type: 'board', path: msg.path, board: mockBoard });
        emit({ type: 'proposal', path: msg.path, kind: 'board', proposed: null });
      } else {
        const proposed = currentArchProposal();
        if (proposed) mockArch = proposed;
        mockArchProposal = null;
        emit({ type: 'architecture', path: msg.path, doc: mockArch });
        emit({ type: 'proposal', path: msg.path, kind: 'architecture', proposed: null });
      }
    }, 10);
    return;
  }
  if (msg.type === 'rejectProposal') {
    setTimeout(() => {
      if (msg.kind === 'board') {
        mockBoardProposal = null;
        emit({ type: 'proposal', path: msg.path, kind: 'board', proposed: null });
      } else {
        mockArchProposal = null;
        emit({ type: 'proposal', path: msg.path, kind: 'architecture', proposed: null });
      }
    }, 10);
    return;
  }
  if (msg.type === 'updateArchitecture') {
    mockArch = msg.doc; // keep preview in sync within the session
    return;
  }
  if (msg.type === 'requestPipeline') {
    setTimeout(() => emit({ type: 'pipeline', path: msg.path, config: mockPipeline }), 15);
    return;
  }
  if (msg.type === 'updatePipeline') {
    mockPipeline = msg.config; // keep preview in sync within the session
    return;
  }
  if (msg.type === 'queueTransition') {
    // Surface only: append to the in-memory queue (an agent would drain the real file).
    mockQueue = appendQueueEntry(
      mockQueue,
      buildQueueEntry({ id: msg.cardId, title: msg.cardTitle }, msg.from, msg.to, msg.skill),
    );
    // Re-emit the updated queue summary so the header badge increments live.
    setTimeout(
      () =>
        emit({ type: 'pipelineQueue', path: msg.path, summary: summarizeQueue(mockQueue.entries) }),
      5,
    );
    return;
  }
  if (
    msg.type === 'updateSettings' ||
    msg.type === 'revealInExplorer' ||
    msg.type === 'duplicate'
  ) {
    return; // no-op in preview
  }
  if (msg.type === 'updateRelaunch') {
    return; // no-op in preview (the real host quits and installs)
  }
  if (msg.type === 'updateCheck') {
    // Preview analogue of the host's auto-update lifecycle (electron/updater.ts): the real
    // updater only runs in a packaged build, so simulate the event sequence here so the
    // sidebar card + Settings → About states are demonstrable in the browser preview.
    // Alternate per check: up-to-date, then a full checking → available → downloading
    // (progress) → ready flow, so both outcomes are visible.
    const flip = mockUpdateFlips++;
    emit({ type: 'updateStatus', status: 'checking' });
    if (flip % 2 === 0) {
      setTimeout(() => emit({ type: 'updateStatus', status: 'up-to-date' }), 700);
      return;
    }
    const v = '0.2.0';
    setTimeout(() => {
      emit({ type: 'updateStatus', status: 'available', version: v });
      let pct = 0;
      const tick = setInterval(() => {
        pct += 20;
        if (pct >= 100) {
          clearInterval(tick);
          emit({ type: 'updateStatus', status: 'ready', version: v });
        } else {
          emit({ type: 'updateStatus', status: 'downloading', version: v, percent: pct });
        }
      }, 500);
    }, 700);
    return;
  }
  if (msg.type === 'kill') {
    // Drop the session and re-broadcast the smaller list — the preview analogue
    // of the host's kill → remove → state path. Closing every session emits an
    // empty list so the app falls back to the initial start state (J3).
    const i = allMockSessions.findIndex((s) => s.id === msg.id);
    if (i >= 0) allMockSessions.splice(i, 1);
    mockOrder = mockOrder.filter((id) => id !== msg.id);
    setTimeout(() => emit(mockState()), 10);
    return;
  }
  if (msg.type === 'openRepo') {
    // Preview analogue of the host's openRepo → SessionManager.create. Append a new
    // running session for the chosen repo; carry the N2 cardId so the new session links
    // back to the originating board card and the card's status badge appears immediately.
    const id = `sess-${Date.now().toString(36)}`;
    // Mirror the host's SessionManager.create default: folder basename only, no suffix.
    const name =
      msg.path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || msg.path;
    const ts = Date.now();
    allMockSessions.push({
      id,
      name,
      agentId: msg.agentId,
      projectPath: msg.path,
      status: 'running',
      createdAt: ts,
      lastActiveAt: ts,
      ...(msg.cardId ? { cardId: msg.cardId } : {}),
    });
    mockOrder = [...mockOrder, id];
    setTimeout(() => emit(mockState()), 10);
    return;
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
    setTimeout(
      () => emit({ type: 'dirEntries', path: msg.path, entries: mockDirEntries(msg.path) }),
      15,
    );
    return;
  }
  if (msg.type === 'readFile') {
    const isMd = msg.path.endsWith('.md');
    setTimeout(
      () =>
        emit({
          type: 'fileContent',
          doc: {
            path: msg.path,
            content: isMd ? mockMarkdown : mockFileText,
            language: isMd ? 'markdown' : 'typescript',
            truncated: false,
            binary: false,
          },
        }),
      15,
    );
    return;
  }
  if (msg.type === 'readDiff') {
    // Match the per-file Review corpus by basename so the global Review view (R3) shows
    // realistic stacked hunks + fold rows in the preview; fall back to a tiny one-line
    // change for any path not in the corpus (e.g. a single diff tab open).
    const leaf =
      msg.path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() ?? msg.path;
    const corpus = mockDiffs[leaf];
    setTimeout(
      () =>
        emit({
          type: 'fileDiff',
          doc: {
            path: msg.path,
            head: corpus ? corpus.head : 'const a = 1;\n',
            work: corpus ? corpus.work : 'const a = 2;\n',
            binary: false,
          },
        }),
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
