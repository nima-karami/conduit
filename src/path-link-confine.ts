/**
 * Confinement of a decoded link target (src/link-target.ts) to the session's user-chosen roots
 * (plan 2026-10-16-terminal-path-links Contracts "v1 OSC 8 / file://"). Host-only through the
 * default realpath; the checks themselves are string work with platform and case injected, so the
 * win32 cases run on ubuntu. Lexical first with no fs, then the realpath against the SAME root's
 * realpath (ADR 0005 §3, amended 2026-09-30).
 */
import { realPathLeaf } from './path-guard';
import {
  isAbsoluteToken,
  isUncLike,
  normalizeAbs,
  type PathPlatform,
} from './path-token-normalize';

export interface ConfineDeps {
  /** Forward-slashed result. */
  realPathLeaf: (t: string) => string;
  platform: PathPlatform;
  caseSensitive: boolean;
}

/** realPathLeaf (sync, once per click — plan Global constraints) with a forward-slashed result. */
export const slashedRealPathLeaf = (t: string): string => realPathLeaf(t).replace(/\\/g, '/');

/** `key` at or under `rootKey`; a drive root (`g:/`) already ends in its separator. */
function under(rootKey: string, key: string): boolean {
  if (key === rootKey) return true;
  return key.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`);
}

/** Callers open `real`, never `abs`. */
export function confineToRoots(
  abs: string,
  roots: readonly string[],
  deps: ConfineDeps,
): { root: string; real: string } | null {
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

  const real = deps.realPathLeaf(target);
  const realRoot = deps.realPathLeaf(norm(best));
  if (isUncLike(real) || isUncLike(realRoot)) return null;
  // Against the lexical root's own realpath: a link out of it is refused even when it lands
  // inside another root, so one root can never vouch for another's escape.
  if (!under(key(realRoot), key(real))) return null;
  return { root: best, real: norm(real) };
}
