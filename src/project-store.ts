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

const MAX_NAME = 80;

export function normalizeProjectName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= MAX_NAME ? name : null;
}

export class ProjectStore {
  private projects: Project[];
  private listeners: (() => void)[] = [];

  constructor(
    initial: readonly Project[],
    private readonly newId: () => string,
  ) {
    this.projects = initial.map((p) => ({ ...p }));
  }

  list(): Project[] {
    return [...this.projects].sort(byOrder).map((p) => ({ ...p }));
  }

  has(id: string): boolean {
    return this.projects.some((p) => p.id === id);
  }

  onChange(cb: () => void): { dispose(): void } {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  replaceAll(projects: readonly Project[]): void {
    this.projects = projects.map((p) => ({ ...p }));
    this.emit();
  }

  create(name: unknown): Project | null {
    const clean = normalizeProjectName(name);
    if (clean === null) return null;
    const order = this.projects.reduce((m, p) => Math.max(m, p.order), -1) + 1;
    const project = { id: this.newId(), name: clean, order };
    this.projects.push(project);
    this.emit();
    return { ...project };
  }

  rename(id: unknown, name: unknown): boolean {
    const clean = normalizeProjectName(name);
    const p = this.projects.find((x) => x.id === id);
    if (!p || clean === null || p.name === clean) return false;
    p.name = clean;
    this.emit();
    return true;
  }

  delete(id: unknown): boolean {
    const i = this.projects.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.projects.splice(i, 1);
    this.renumber(this.list().map((p) => p.id));
    this.emit();
    return true;
  }

  reorder(ids: unknown): boolean {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return false;
    const before = this.list().map((p) => p.id);
    const known = new Set(before);
    const next = [...new Set(ids.filter((x) => known.has(x)))];
    for (const id of before) if (!next.includes(id)) next.push(id);
    const changed = this.renumber(next);
    if (changed) this.emit();
    return true;
  }

  private renumber(ids: readonly string[]): boolean {
    let changed = false;
    for (const p of this.projects) {
      const order = ids.indexOf(p.id);
      if (p.order !== order) {
        p.order = order;
        changed = true;
      }
    }
    return changed;
  }
}
