import type { Project, Session } from './types';

/** Legacy key stays stable for No space; project ids are never this string (mf-model mints `p-…`). */
export const STANDALONE_KEY = 'standalone';

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** The group a session renders in: its projectId when that names a project in `projects`, else STANDALONE_KEY. */
export function groupKeyOf(s: Pick<Session, 'projectId'>, projects: readonly Project[]): string {
  const id = s.projectId;
  return id !== undefined && projects.some((p) => p.id === id) ? id : STANDALONE_KEY;
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
      ? 'Its agents keep running without a space.'
      : count >= 2
        ? `Its ${count} agents keep running without a space.`
        : count === 1
          ? 'Its 1 agent keeps running without a space.'
          : 'It has no agents.';
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

export interface PickerRow {
  key: string; // project id | STANDALONE_KEY
  label: string;
  current: boolean;
}

/** Projects in `projects` order whose name contains the trimmed filter (case-insensitive), then
 *  the no-space row (always). noMatch = a non-empty filter matched no project. */
export function projectPickerRows(
  projects: readonly Project[],
  filter: string,
  currentKey: string,
): { rows: PickerRow[]; noMatch: boolean } {
  const q = filter.trim().toLowerCase();
  const matched = projects.filter((p) => p.name.toLowerCase().includes(q));
  const rows: PickerRow[] = [
    ...matched.map((p) => ({ key: p.id, label: p.name, current: p.id === currentKey })),
    { key: STANDALONE_KEY, label: 'No space', current: currentKey === STANDALONE_KEY },
  ];
  return { rows, noMatch: q !== '' && matched.length === 0 };
}
