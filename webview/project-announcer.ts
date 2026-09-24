import type { Project } from '../src/types';
import { requestHost } from './host-request';

// The live region's text for mf-sidebar spec AC 14. One module so every surface that moves or
// deletes a project announces through the same polite region in the sidebar.

const ZWSP = '\u200b';

let snapshot = '';
const listeners = new Set<() => void>();
const pendingDeletes = new Map<string, { name: string; at: number }>();
// A refused delete (store unavailable) gets no reply, so a pending entry that outlives this is
// dropped — otherwise a later delete of the same id from another window would be announced here.
const PENDING_DELETE_MS = 10_000;

function announce(text: string): void {
  // A live region only speaks on a change, so a repeat differs by a zero-width space.
  snapshot = snapshot === text ? text + ZWSP : text;
  for (const cb of listeners) cb();
}

export const projectAnnouncer = {
  /** Pending until the id leaves `state.projects`: the delete is host-owned, not optimistic. */
  noteDelete(projectId: string, name: string): void {
    pendingDeletes.set(projectId, { name, at: Date.now() });
  },
  observeProjects(projects: readonly Project[]): void {
    const now = Date.now();
    for (const [id, { name, at }] of pendingDeletes) {
      if (projects.some((p) => p.id === id)) {
        if (now - at > PENDING_DELETE_MS) pendingDeletes.delete(id);
        continue;
      }
      pendingDeletes.delete(id);
      announce(`Deleted ${name}`);
    }
  },
  /** Posts the move and announces the host's answer; a timeout says nothing, since the rail
   *  shows the truth either way. */
  moveSession(
    sessionId: string,
    projectId: string | null,
    text: { session: string; target: string },
  ): void {
    void requestHost(
      (requestId) => ({ type: 'session:setProject', sessionId, projectId, requestId }),
      ['session:opResult'],
      10_000,
    ).then((reply) => {
      if (!reply) return;
      announce(
        reply.ok ? `Moved ${text.session} to ${text.target}` : `Couldn't move ${text.session}`,
      );
    });
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
