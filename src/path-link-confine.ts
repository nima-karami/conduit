/**
 * Confinement of a decoded link target (src/link-target.ts) to the session's user-chosen roots
 * (plan 2026-10-16-terminal-path-links Contracts "v1 OSC 8 / file://"). The checks are string
 * work with platform and case injected, so the win32 cases run on ubuntu; the realpath is async
 * and goes through an injected fs. Lexical first with no fs, then the realpath against the SAME
 * root's realpath (ADR 0005 §3, amended 2026-09-30).
 */
import { promises as fsp } from 'node:fs';
import {
  isAbsoluteToken,
  isUncLike,
  normalizeAbs,
  type PathPlatform,
} from './path-token-normalize';

export interface ConfineDeps {
  /** Forward-slashed result; null refuses the target. */
  realPathLeaf: (t: string) => Promise<string | null>;
  platform: PathPlatform;
  caseSensitive: boolean;
}

/** The slice of fs.promises safeRealPathLeaf reads. */
export interface LinkFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(p: string): Promise<string>;
  realpath(p: string): Promise<string>;
}

export const nodeLinkFs: LinkFs = {
  lstat: (p) => fsp.lstat(p),
  readlink: (p) => fsp.readlink(p),
  realpath: (p) => fsp.realpath(p),
};

/** ELOOP territory; a planted chain is refused, never followed further. */
export const MAX_LINK_HOPS = 32;
/** Path components visited, links' included: bounds the walk a missing target used to make up
 *  every ancestor (T8.4 security r1 H3). */
export const MAX_WALK_STEPS = 256;

const slash = (p: string) => p.replace(/\\/g, '/');
const join = (base: string, seg: string) => (base.endsWith('/') ? base + seg : `${base}/${seg}`);
const DRIVE_ROOT_RE = /^[A-Za-z]:\//;

/** `G:/` or `/` for an absolute (normalized, forward-slashed) path; null when relative. A win32
 *  `/x` is drive-relative, so it takes the drive of `from`. */
function rootOf(p: string, platform: PathPlatform, from: string): string | null {
  if (DRIVE_ROOT_RE.test(p)) return p.slice(0, 3);
  if (!p.startsWith('/')) return null;
  return platform === 'win32' ? (DRIVE_ROOT_RE.exec(from)?.[0] ?? null) : '/';
}

function parentOf(p: string, root: string): string {
  if (p === root) return p;
  const cut = p.lastIndexOf('/');
  return cut < root.length ? root : p.slice(0, cut);
}

/**
 * The realpath of `target` (or of its nearest existing ancestor, with the missing tail
 * re-appended, so a symlinked parent cannot escape either), forward-slashed. Each component is
 * lstat'ed and each link read before anything follows it: a link whose target is UNC-like is
 * refused before a realpath or stat could open an SMB connection to it (T8.4 security r1 H2).
 * Null refuses: a UNC-like link or result, a link chain past MAX_LINK_HOPS, a walk past
 * MAX_WALK_STEPS, or an unreadable link.
 */
export async function safeRealPathLeaf(
  target: string,
  fs: LinkFs,
  platform: PathPlatform,
): Promise<string | null> {
  if (isUncLike(target)) return null;
  const start = normalizeAbs(target, platform);
  const startRoot = rootOf(start, platform, start);
  if (!startRoot) return null;
  const realOf = async (p: string): Promise<string | null> => {
    try {
      const real = slash(await fs.realpath(p));
      return isUncLike(real) ? null : real;
    } catch {
      return null;
    }
  };

  let root = startRoot;
  let resolved = root;
  let pending = start.slice(root.length).split('/').filter(Boolean);
  let hops = 0;
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > MAX_WALK_STEPS) return null;
    const seg = pending.shift() as string;
    if (seg === '.') continue;
    if (seg === '..') {
      resolved = parentOf(resolved, root);
      continue;
    }
    const next = join(resolved, seg);
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(next)).isSymbolicLink();
    } catch {
      // Missing (or unreadable): only the existing part is realpath'ed, once.
      const real = await realOf(resolved);
      if (real === null) return null;
      return normalizeAbs([seg, ...pending].reduce(join, real), platform);
    }
    if (!isLink) {
      resolved = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    let to: string;
    try {
      to = slash(await fs.readlink(next));
    } catch {
      return null;
    }
    if (isUncLike(to)) return null;
    const toRoot = rootOf(to, platform, resolved);
    if (toRoot) {
      root = toRoot;
      resolved = toRoot;
      pending = [
        ...to
          .slice(DRIVE_ROOT_RE.test(to) ? 3 : 1)
          .split('/')
          .filter(Boolean),
        ...pending,
      ];
    } else {
      pending = [...to.split('/').filter(Boolean), ...pending];
    }
  }
  return realOf(resolved);
}

/** The host's realPathLeaf for confinement: async, off the main thread's sync fs path (H3). */
export const hostRealPathLeaf =
  (platform: PathPlatform) =>
  (t: string): Promise<string | null> =>
    safeRealPathLeaf(t, nodeLinkFs, platform);

/** `key` at or under `rootKey`; a drive root (`g:/`) already ends in its separator. */
function under(rootKey: string, key: string): boolean {
  if (key === rootKey) return true;
  return key.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`);
}

/** Callers open `real`, never `abs`. */
export async function confineToRoots(
  abs: string,
  roots: readonly string[],
  deps: ConfineDeps,
): Promise<{ root: string; real: string } | null> {
  const norm = (p: string) => normalizeAbs(p, deps.platform);
  const key = (p: string) => (deps.caseSensitive ? norm(p) : norm(p).toLowerCase());
  if (!abs || isUncLike(abs) || !isAbsoluteToken(abs, deps.platform)) return null;

  const target = norm(abs);
  const targetKey = key(target);
  let best: string | undefined;
  let bestLen = -1;
  for (const r of roots) {
    if (isUncLike(r)) continue;
    const rk = key(r);
    if (under(rk, targetKey) && rk.length > bestLen) {
      best = r;
      bestLen = rk.length;
    }
  }
  if (best === undefined) return null;

  const real = await deps.realPathLeaf(target);
  if (real === null || isUncLike(real)) return null;
  const realRoot = await deps.realPathLeaf(norm(best));
  if (realRoot === null || isUncLike(realRoot)) return null;
  // Against the lexical root's own realpath: a link out of it is refused even when it lands
  // inside another root, so one root can never vouch for another's escape.
  if (!under(key(realRoot), key(real))) return null;
  return { root: best, real: norm(real) };
}
