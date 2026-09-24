import type { SessionSort } from './settings';
import type { Project, Session, SessionStatus } from './types';

/** Group key of the standalone group; project ids are never this string (mf-model mints `p-…`). */
export const STANDALONE_KEY = 'standalone';

export interface SessionGroup {
  key: string;
  project: Project | null;
  sessions: Session[];
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const STATUS_RANK: Record<SessionStatus, number> = { running: 0, stale: 1, exited: 2 };

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** The group a session renders in: its projectId when that names a project in `projects`, else STANDALONE_KEY. */
export function groupKeyOf(s: Pick<Session, 'projectId'>, projects: readonly Project[]): string {
  const id = s.projectId;
  return id !== undefined && projects.some((p) => p.id === id) ? id : STANDALONE_KEY;
}

/** Sort only; 'manual' keeps the input (global) order. */
export function sortSessions(
  list: readonly Session[],
  sort: SessionSort,
  projects: readonly Project[],
): Session[] {
  const arr = [...list];
  switch (sort) {
    case 'manual':
      break;
    case 'name':
      arr.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'recent':
      arr.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'active':
      arr.sort(
        (a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name),
      );
      break;
    case 'status':
      arr.sort(
        (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name),
      );
      break;
    case 'project': {
      const nameOf = (s: Session) => projects.find((p) => p.id === s.projectId)?.name;
      arr.sort((a, b) => {
        const pa = nameOf(a);
        const pb = nameOf(b);
        if (pa === undefined || pb === undefined) {
          if (pa !== pb) return pa === undefined ? 1 : -1;
        } else {
          const c = byName(pa, pb);
          if (c !== 0) return c;
        }
        return a.name.localeCompare(b.name);
      });
      break;
    }
  }
  return arr;
}

/** sortSessions, then needs-you sessions float to the top — never in manual, which is the
 *  user's explicit order. Stable within each partition. */
export function orderSessions(
  list: readonly Session[],
  sort: SessionSort,
  projects: readonly Project[],
): Session[] {
  const sorted = sortSessions(list, sort, projects);
  if (sort === 'manual') return sorted;
  return [...sorted.filter((s) => s.needsAttention), ...sorted.filter((s) => !s.needsAttention)];
}

/** The grouped rail (mf-sidebar spec §2.1): every project, empty ones only while unfiltered
 *  (D10), then Standalone last and only when it has sessions. */
export function groupSessions(
  sessions: readonly Session[],
  projects: readonly Project[],
  opts: { sort: SessionSort; filterActive: boolean },
): SessionGroup[] {
  const ordered = orderSessions(sessions, opts.sort, projects);
  const heads = [...projects].sort(
    opts.sort === 'manual' ? (a, b) => a.order - b.order : (a, b) => byName(a.name, b.name),
  );
  const groups: SessionGroup[] = heads.map((p) => ({
    key: p.id,
    project: p,
    sessions: ordered.filter((s) => s.projectId === p.id),
  }));
  const shown = opts.filterActive ? groups.filter((g) => g.sessions.length > 0) : groups;
  const standalone = ordered.filter((s) => groupKeyOf(s, projects) === STANDALONE_KEY);
  if (standalone.length > 0) {
    shown.push({ key: STANDALONE_KEY, project: null, sessions: standalone });
  }
  return shown;
}

export function sessionMatchesFilter(
  s: Pick<Session, 'name' | 'home' | 'roots'>,
  q: string,
  ctx: { projectName: string | undefined; agentLabel: string },
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const fields = [
    s.name,
    ctx.projectName ?? '',
    baseName(s.home),
    ...s.roots.map(baseName),
    ctx.agentLabel,
  ];
  return fields.some((f) => f.toLowerCase().includes(needle));
}

/** Full project id order after dropping header `dragId` before `targetId` in the rendered
 *  order; null when either is not rendered, they are the same, or nothing would change. */
export function projectOrderAfterDrop(
  renderedIds: readonly string[],
  dragId: string,
  targetId: string,
  currentIds: readonly string[],
): string[] | null {
  if (dragId === targetId || !renderedIds.includes(dragId) || !renderedIds.includes(targetId)) {
    return null;
  }
  const without = renderedIds.filter((id) => id !== dragId);
  const at = without.indexOf(targetId);
  const next = [...without.slice(0, at), dragId, ...without.slice(at)];
  const same = next.length === currentIds.length && next.every((id, i) => id === currentIds[i]);
  return same ? null : next;
}

const DELETE_SUFFIX = "Folders and their .conduit/ data aren't touched.";

/** The delete confirm's copy (mf-sidebar spec §2.6). `count` is this window's sessions only,
 *  so with several windows open the count-free form is used (D13). */
export function deleteProjectDialog(
  name: string,
  count: number,
  windowCount: number,
): { title: string; message: string } {
  const lead =
    windowCount > 1
      ? 'Its sessions become standalone and keep running.'
      : count >= 2
        ? `Its ${count} sessions become standalone and keep running.`
        : count === 1
          ? 'Its 1 session becomes standalone and keeps running.'
          : 'It has no sessions.';
  return { title: `Delete “${name}”?`, message: `${lead} ${DELETE_SUFFIX}` };
}

/** The session Open board selects: activeId if it is in the project, else the project's session
 *  with the highest lastActiveAt (ties: first in `sessions`); undefined when none. */
export function openBoardTarget(
  projectId: string,
  sessions: readonly Session[],
  activeId: string | undefined,
): string | undefined {
  const members = sessions.filter((s) => s.projectId === projectId);
  if (activeId !== undefined && members.some((s) => s.id === activeId)) return activeId;
  let best: Session | undefined;
  for (const s of members) if (!best || s.lastActiveAt > best.lastActiveAt) best = s;
  return best?.id;
}

/** A card dropped on a group header (spec §2.8): null = its own group, a no-op. */
export function cardDropIntent(
  sourceKey: string,
  targetKey: string,
): { projectId: string | null } | null {
  if (sourceKey === targetKey) return null;
  return { projectId: targetKey === STANDALONE_KEY ? null : targetKey };
}

export interface PickerRow {
  key: string; // project id | STANDALONE_KEY
  label: string;
  current: boolean;
}

/** Projects in `projects` order whose name contains the trimmed filter (case-insensitive), then
 *  the Standalone row (always). noMatch = a non-empty filter matched no project. */
export function projectPickerRows(
  projects: readonly Project[],
  filter: string,
  currentKey: string,
): { rows: PickerRow[]; noMatch: boolean } {
  const q = filter.trim().toLowerCase();
  const matched = projects.filter((p) => p.name.toLowerCase().includes(q));
  const rows: PickerRow[] = [
    ...matched.map((p) => ({ key: p.id, label: p.name, current: p.id === currentKey })),
    { key: STANDALONE_KEY, label: 'Standalone', current: currentKey === STANDALONE_KEY },
  ];
  return { rows, noMatch: q !== '' && matched.length === 0 };
}
