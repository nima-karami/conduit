import type { FileRead } from './config';
import type { Project } from './types';

const VERSION = 1;
const UNTITLED = 'Untitled project';

export type ProjectsLoad =
  | { kind: 'absent' }
  | { kind: 'ok'; projects: Project[] }
  | { kind: 'corrupt' }
  | { kind: 'future'; version: number }
  | { kind: 'unreadable'; code: string };

const byOrder = (a: Project, b: Project) => a.order - b.order;

/** See mf-model spec §2.3 "projects.json read". */
export function parseProjects(read: FileRead): ProjectsLoad {
  if (read.kind !== 'text') return read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt' };
  const { version, projects } = parsed as { version?: unknown; projects?: unknown };
  if (typeof version !== 'number' || Number.isNaN(version)) return { kind: 'corrupt' };
  if (version > VERSION) return { kind: 'future', version };
  if (version !== VERSION || !Array.isArray(projects)) return { kind: 'corrupt' };

  const seen = new Set<string>();
  const kept: Project[] = [];
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, order } = entry as { id?: unknown; name?: unknown; order?: unknown };
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    const trimmed = typeof name === 'string' ? name.trim() : '';
    kept.push({
      id,
      name: trimmed || UNTITLED,
      order: typeof order === 'number' && Number.isFinite(order) ? order : Infinity,
    });
  }
  kept.sort(byOrder);
  return { kind: 'ok', projects: kept.map((p, i) => ({ ...p, order: i })) };
}

export function serializeProjects(projects: readonly Project[]): string {
  return JSON.stringify({ version: VERSION, projects });
}

export class ProjectStore {
  private readonly projects: Project[];

  constructor(initial: readonly Project[], _newId: () => string) {
    this.projects = initial.map((p) => ({ ...p }));
  }

  list(): Project[] {
    return [...this.projects].sort(byOrder).map((p) => ({ ...p }));
  }
}
