import { folderKey } from './folder-key';
import { MAX_ROOTS } from './folder-validation';
import type { NewSessionPrefill } from './new-session-seed';
import { isAncestorOf, normalizePath } from './owning-session';
import type { Session } from './types';

export type OsOpenWindow = 'this' | 'new';

export interface OsOpenChoice {
  mode: 'existing' | 'new';
  agentId: string;
  projectId: string | null;
  window: OsOpenWindow;
}

type SessionOption = Pick<Session, 'id' | 'name' | 'home'>;

export interface OsOpenPicker {
  id: number;
  prefill: NewSessionPrefill;
  matching: SessionOption[];
  other: SessionOption[];
  selectedSessionId: string | null;
  window: OsOpenWindow;
  targetPaths: string[];
}

export function parseOsOpenChoice(raw: string | undefined): OsOpenChoice | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { mode, agentId, projectId, window } = value as Record<string, unknown>;
  if (
    (mode !== 'existing' && mode !== 'new') ||
    typeof agentId !== 'string' ||
    (projectId !== null && typeof projectId !== 'string') ||
    (window !== 'this' && window !== 'new')
  )
    return undefined;
  return { mode, agentId, projectId, window };
}

export function osOpenPrefill(
  folders: readonly string[],
  fileHomes: readonly string[],
  choice?: OsOpenChoice,
): NewSessionPrefill {
  const seen = new Set<string>();
  const [home, ...roots] = [...folders, ...fileHomes]
    .filter((folder) => {
      const key = folderKey(folder);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ROOTS);
  return {
    home,
    roots,
    ...(choice ? { agentId: choice.agentId, projectId: choice.projectId } : {}),
  };
}

export function osOpenSessions(
  paths: readonly string[],
  files: readonly string[],
  sessions: readonly Session[],
  openDocs: readonly { path: string; sessionId: string }[],
): Pick<OsOpenPicker, 'matching' | 'other'> {
  const normalized = paths.map(normalizePath);
  const normalizedFiles = new Set(files.map(normalizePath));
  const opened = new Set(
    openDocs
      .filter((doc) => normalizedFiles.has(normalizePath(doc.path)))
      .map((doc) => doc.sessionId),
  );
  const ranked = sessions.map((session) => {
    let depth = -1;
    let home = false;
    for (const [index, folder] of [session.home, ...session.roots].entries()) {
      const root = normalizePath(folder);
      if (root.length <= depth || !normalized.some((path) => isAncestorOf(root, path))) continue;
      depth = root.length;
      home = index === 0;
    }
    return { session, depth, home, opened: opened.has(session.id) };
  });
  const matching = ranked
    .filter((r) => r.depth >= 0)
    .sort(
      (a, b) =>
        Number(b.opened) - Number(a.opened) || b.depth - a.depth || Number(b.home) - Number(a.home),
    );
  const other = files.length
    ? ranked.filter((r) => r.depth < 0 && r.session.status === 'running')
    : [];
  const option = ({ session: { id, name, home } }: (typeof ranked)[number]) => ({ id, name, home });
  return { matching: matching.map(option), other: other.map(option) };
}

export function osOpenSelection(
  choice: OsOpenChoice | undefined,
  matching: OsOpenPicker['matching'],
): string | null {
  return choice?.mode === 'existing' ? (matching[0]?.id ?? null) : null;
}
