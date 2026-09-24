import type { Project } from '../src/types';

// The live region's text for mf-sidebar spec AC 14. One module so every surface that moves or
// deletes a project announces through the same polite region in the sidebar.

const ZWSP = '​';

let snapshot = '';
const listeners = new Set<() => void>();
const pendingDeletes = new Map<string, string>();

function announce(text: string): void {
  // A live region only speaks on a change, so a repeat differs by a zero-width space.
  snapshot = snapshot === text ? text + ZWSP : text;
  for (const cb of listeners) cb();
}

export const projectAnnouncer = {
  /** Pending until the id leaves `state.projects`: the delete is host-owned, not optimistic. */
  noteDelete(projectId: string, name: string): void {
    pendingDeletes.set(projectId, name);
  },
  observeProjects(projects: readonly Project[]): void {
    for (const [id, name] of pendingDeletes) {
      if (projects.some((p) => p.id === id)) continue;
      pendingDeletes.delete(id);
      announce(`Deleted ${name}`);
    }
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): string {
    return snapshot;
  },
};
