import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Workspace roots are stored lexically (mf-model spec D15), but `realPathLeaf`, git and the
 * preview handler all hand back realpaths, and a realpath expands 8.3 short names. A root
 * registered as `C:\Users\RUNNER~1\x` therefore refused every write under itself "(symlink)".
 *
 * This rewrites 8.3 components only. Links are never followed — that would be storing
 * realpaths, which D15 leaves alone — and a long name is only taken when it names the SAME
 * entry (same ino/dev), so the result always denotes the directory the user asked for.
 */

const SHORT_COMPONENT = /~\d/;

export interface ShortNameDeps {
  path: {
    resolve(...p: string[]): string;
    parse(p: string): { root: string };
    join(...p: string[]): string;
    basename(p: string): string;
    sep: string;
  };
  lstat: (
    p: string,
  ) => Promise<{ ino: bigint | number; dev: bigint | number; isSymbolicLink(): boolean }>;
  /** Must expand 8.3 names (`fs.promises.realpath` does; the JS `fs.realpathSync` does not). */
  realpath: (p: string) => Promise<string>;
}

export function hasShortComponent(p: string): boolean {
  return SHORT_COMPONENT.test(p);
}

export async function expandShortNames(p: string, deps: ShortNameDeps): Promise<string> {
  if (!hasShortComponent(p)) return p;
  const abs = deps.path.resolve(p);
  const { root } = deps.path.parse(abs);
  const segments = abs.slice(root.length).split(deps.path.sep).filter(Boolean);
  if (!segments.some((s) => SHORT_COMPONENT.test(s))) return abs;
  let out = root;
  for (const [i, seg] of segments.entries()) {
    const spelled = deps.path.join(out, seg);
    if (!SHORT_COMPONENT.test(seg)) {
      out = spelled;
      continue;
    }
    let entry: Awaited<ReturnType<ShortNameDeps['lstat']>>;
    try {
      entry = await deps.lstat(spelled);
    } catch {
      return deps.path.join(out, ...segments.slice(i));
    }
    out = entry.isSymbolicLink() ? spelled : await longSpelling(out, spelled, entry, deps);
  }
  return out;
}

async function longSpelling(
  parent: string,
  spelled: string,
  entry: { ino: bigint | number; dev: bigint | number },
  deps: ShortNameDeps,
): Promise<string> {
  try {
    const candidate = deps.path.join(parent, deps.path.basename(await deps.realpath(spelled)));
    const other = await deps.lstat(candidate);
    return other.ino === entry.ino && other.dev === entry.dev ? candidate : spelled;
  } catch {
    return spelled;
  }
}

export const hostShortNameDeps: ShortNameDeps = {
  path,
  lstat: (p) => fs.promises.lstat(p, { bigint: true }),
  realpath: (p) => fs.promises.realpath(p),
};
