import { folderKey } from './folder-key';
import {
  type DroppedRoot,
  folderKeysOf,
  MAX_ROOTS,
  type ProbedFolder,
  placementConflict,
  type probeFolder,
  type SessionOpReason,
} from './folder-validation';
import type { ProjectStore } from './project-store';
import type { SessionManager } from './session-manager';

export type SessionOpResult = { ok: true } | { ok: false; reason: SessionOpReason };

export interface SessionOpsDeps {
  mgr: Pick<
    SessionManager,
    'get' | 'addRoot' | 'removeRoot' | 'replaceRoot' | 'setHome' | 'setProject'
  >;
  projects: Pick<ProjectStore, 'has'>;
  probe: (raw: unknown) => ReturnType<typeof probeFolder>;
  realKeys: Map<string, string>;
  onFoldersChanged: (sessionId: string, change: { homeChanged: boolean }) => void;
}

export interface SessionOps {
  addRoot(sessionId: unknown, path: unknown): Promise<SessionOpResult>;
  removeRoot(sessionId: unknown, path: unknown): SessionOpResult;
  /** The wire never sends `keepOldHome`; `false` is mf-files' Locate of a missing home (L12 S8). */
  setHome(sessionId: unknown, path: unknown, keepOldHome?: boolean): Promise<SessionOpResult>;
  replaceRoot(sessionId: string, oldPath: string, newPath: string): Promise<SessionOpResult>;
  setProject(sessionId: unknown, projectId: unknown): SessionOpResult;
  resolveInitialRoots(
    home: string,
    roots: unknown,
  ): Promise<{ roots: string[]; missing: string[]; dropped: DroppedRoot[] }>;
  /** The full validator for a root that came back; `null` = its missing mark may clear (B1). */
  revalidate(sessionId: string, root: string): Promise<SessionOpReason | null>;
}

const OK: SessionOpResult = { ok: true };
const fail = (reason: SessionOpReason): SessionOpResult => ({ ok: false, reason });

const candidateKeys = (p: ProbedFolder) =>
  p.status === 'present' && p.realKey !== p.key ? [p.key, p.realKey] : [p.key];

/** See mf-model plan Contracts "src/session-ops.ts" for each op's existing-key set. */
export function createSessionOps(deps: SessionOpsDeps): SessionOps {
  const { mgr, realKeys } = deps;
  const session = (id: unknown) => (typeof id === 'string' ? mgr.get(id) : undefined);
  const remember = (p: ProbedFolder) => {
    if (p.status === 'present') realKeys.set(p.key, p.realKey);
  };

  const probePresent = async (sessionId: unknown, raw: unknown) => {
    const probed = await deps.probe(raw);
    if ('reason' in probed) return fail(probed.reason);
    if (probed.status === 'missing') return fail('not-found');
    const s = session(sessionId);
    if (!s) return fail('unknown-session');
    return { s, probed };
  };

  return {
    async addRoot(sessionId, raw) {
      if (!session(sessionId)) return fail('unknown-session');
      const r = await probePresent(sessionId, raw);
      if ('ok' in r) return r;
      const { s, probed } = r;
      const conflict = placementConflict(
        candidateKeys(probed),
        folderKeysOf([s.home, ...s.roots], realKeys),
      );
      if (conflict) return fail(conflict);
      if (s.roots.length >= MAX_ROOTS) return fail('too-many');
      remember(probed);
      mgr.addRoot(s.id, probed.stored);
      deps.onFoldersChanged(s.id, { homeChanged: false });
      return OK;
    },

    removeRoot(sessionId, raw) {
      const s = session(sessionId);
      if (!s) return fail('unknown-session');
      if (typeof raw !== 'string') return fail('invalid-path');
      const key = folderKey(raw);
      if (key === folderKey(s.home)) return fail('is-home');
      if (!mgr.removeRoot(s.id, key)) return fail('not-attached');
      deps.onFoldersChanged(s.id, { homeChanged: false });
      return OK;
    },

    async setHome(sessionId, raw, keepOldHome = true) {
      const before = session(sessionId);
      if (!before) return fail('unknown-session');
      if (typeof raw !== 'string') return fail('invalid-path');
      const swapped = before.roots.find((x) => folderKey(x) === folderKey(raw));
      if (swapped !== undefined) {
        mgr.setHome(before.id, swapped, keepOldHome);
        deps.onFoldersChanged(before.id, { homeChanged: true });
        return OK;
      }
      const r = await probePresent(sessionId, raw);
      if ('ok' in r) return r;
      const { s, probed } = r;
      if (probed.key === folderKey(s.home)) return fail('duplicate');
      const existing = keepOldHome ? [s.home, ...s.roots] : s.roots;
      const conflict = placementConflict(candidateKeys(probed), folderKeysOf(existing, realKeys));
      if (conflict) return fail(conflict);
      if (keepOldHome && s.roots.length >= MAX_ROOTS) return fail('too-many');
      remember(probed);
      mgr.setHome(s.id, probed.stored, keepOldHome);
      deps.onFoldersChanged(s.id, { homeChanged: true });
      return OK;
    },

    async replaceRoot(sessionId, oldPath, newPath) {
      const oldKey = folderKey(oldPath);
      const attached = (roots: readonly string[]) => roots.some((x) => folderKey(x) === oldKey);
      const before = session(sessionId);
      if (!before) return fail('unknown-session');
      if (!attached(before.roots)) return fail('not-attached');
      const r = await probePresent(sessionId, newPath);
      if ('ok' in r) return r;
      const { s, probed } = r;
      if (!attached(s.roots)) return fail('not-attached');
      const others = s.roots.filter((x) => folderKey(x) !== oldKey);
      const conflict = placementConflict(
        candidateKeys(probed),
        folderKeysOf([s.home, ...others], realKeys),
      );
      if (conflict) return fail(conflict);
      remember(probed);
      mgr.replaceRoot(s.id, oldKey, probed.stored);
      deps.onFoldersChanged(s.id, { homeChanged: false });
      return OK;
    },

    setProject(sessionId, projectId) {
      const s = session(sessionId);
      if (!s) return fail('unknown-session');
      if (projectId === null) {
        mgr.setProject(s.id, undefined);
        return OK;
      }
      if (typeof projectId !== 'string' || !deps.projects.has(projectId)) {
        return fail('unknown-project');
      }
      mgr.setProject(s.id, projectId);
      return OK;
    },

    async resolveInitialRoots(home, roots) {
      const out = { roots: [] as string[], missing: [] as string[], dropped: [] as DroppedRoot[] };
      if (!Array.isArray(roots)) return out;
      const homeKey = folderKey(home);
      const existing = folderKeysOf([home], realKeys);
      for (const raw of roots) {
        const drop = (reason: SessionOpReason) =>
          out.dropped.push({ path: typeof raw === 'string' ? raw : '', reason });
        const probed = await deps.probe(raw);
        if ('reason' in probed) {
          drop(probed.reason);
          continue;
        }
        if (probed.key === homeKey) {
          drop('is-home');
          continue;
        }
        const keys = candidateKeys(probed);
        const conflict = placementConflict(keys, existing);
        if (conflict) {
          drop(conflict);
          continue;
        }
        if (out.roots.length >= MAX_ROOTS) {
          drop('too-many');
          continue;
        }
        remember(probed);
        existing.push(...keys);
        out.roots.push(probed.stored);
        if (probed.status === 'missing') out.missing.push(probed.stored);
      }
      return out;
    },

    async revalidate(sessionId, root) {
      if (!session(sessionId)) return 'unknown-session';
      const r = await probePresent(sessionId, root);
      if ('ok' in r) return r.ok ? null : r.reason;
      const { s, probed } = r;
      const others = [s.home, ...s.roots].filter((x) => folderKey(x) !== probed.key);
      const conflict = placementConflict(candidateKeys(probed), folderKeysOf(others, realKeys));
      if (conflict) return conflict;
      remember(probed);
      return null;
    },
  };
}
