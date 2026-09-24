import { folderKey } from './folder-key';
import type { LocateReason } from './protocol';
import type { SessionOpResult } from './session-ops';
import type { Session } from './types';

export interface LocateDeps {
  get: (sessionId: string) => Session | undefined;
  pick: (defaultPath: string | undefined) => Promise<string | null>;
  isDir: (p: string) => Promise<boolean>;
  dirname: (p: string) => string;
  ops: {
    setHome: (sessionId: string, path: string, keepOldHome: boolean) => Promise<SessionOpResult>;
    replaceRoot: (sessionId: string, oldPath: string, newPath: string) => Promise<SessionOpResult>;
  };
}

/** A rejected pick carries its path so the toast can name the folder the user chose. */
export type LocateOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: LocateReason; path?: string };

async function nearestExistingAncestor(p: string, deps: LocateDeps): Promise<string | undefined> {
  let cur = p;
  for (;;) {
    if (await deps.isDir(cur)) return cur;
    const up = deps.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

/** The one Locate handler (locked L11): validation stays in SessionOps. */
export async function locateFolder(
  sessionId: unknown,
  path: unknown,
  deps: LocateDeps,
): Promise<LocateOutcome> {
  const s = typeof sessionId === 'string' ? deps.get(sessionId) : undefined;
  if (!s) return { ok: false, reason: 'unknown-session' };
  if (typeof path !== 'string') return { ok: false, reason: 'invalid-path' };
  const key = folderKey(path);
  const isHome = key === folderKey(s.home);
  const oldPath = isHome ? s.home : s.roots.find((r) => folderKey(r) === key);
  if (oldPath === undefined) return { ok: false, reason: 'not-attached' };
  const picked = await deps.pick(await nearestExistingAncestor(path, deps));
  if (picked === null) return { ok: false, reason: 'cancelled' };
  const r = isHome
    ? await deps.ops.setHome(s.id, picked, false)
    : await deps.ops.replaceRoot(s.id, oldPath, picked);
  return r.ok ? { ok: true, path: picked } : { ok: false, reason: r.reason, path: picked };
}
