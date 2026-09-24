import { folderKey } from './folder-key';
import { isAncestorOf } from './owning-session';
import { repoBaseName } from './repo-display';
import type { Session } from './types';

export type FolderKind = 'home' | 'attached';

export interface FolderSectionModel {
  /** Stored spelling. */
  path: string;
  key: string;
  kind: FolderKind;
  missing: boolean;
  name: string;
  /** Parent segment, only when another folder shares this basename (spec D15). */
  parentHint?: string;
  label: string;
}

type FolderSource = Pick<Session, 'home' | 'roots' | 'missingRoots' | 'homeMissing'>;

const parentName = (p: string) => {
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs.length > 1 ? segs[segs.length - 2] : undefined;
};

/** The renderer's only folder list: derived from the latest `state`, never held (spec §3.4). */
export function sessionSections(s: FolderSource | undefined): FolderSectionModel[] {
  if (!s) return [];
  const missing = new Set((s.missingRoots ?? []).map(folderKey));
  const raw = [
    { path: s.home, kind: 'home' as const, missing: s.homeMissing === true },
    ...s.roots.map((path) => ({
      path,
      kind: 'attached' as const,
      missing: missing.has(folderKey(path)),
    })),
  ];
  const names = raw.map((r) => repoBaseName(r.path));
  return raw.map((r, i) => {
    const name = names[i];
    const lower = name.toLowerCase();
    const collides = names.some((n, j) => j !== i && n.toLowerCase() === lower);
    const parentHint = collides ? parentName(r.path) : undefined;
    return {
      ...r,
      key: folderKey(r.path),
      name,
      ...(parentHint !== undefined ? { parentHint } : {}),
      label: parentHint !== undefined ? `${name} — ${parentHint}` : name,
    };
  });
}

/** Longest folder in `folders` containing abs (key equality or isAncestorOf), else undefined.
 *  Callers pass present folders only. */
export function folderForPath(folders: readonly string[], abs: string): string | undefined {
  const k = folderKey(abs);
  let best: string | undefined;
  let bestLen = -1;
  for (const f of folders) {
    const fk = folderKey(f);
    if (fk.length > bestLen && isAncestorOf(fk, k)) {
      best = f;
      bestLen = fk.length;
    }
  }
  return best;
}

/** Labels (from `next`) of folders present in both lists whose missing flag flipped. */
export function missingTransitions(
  prev: readonly FolderSectionModel[],
  next: readonly FolderSectionModel[],
): { lost: string[]; back: string[] } {
  const was = new Map(prev.map((s) => [s.key, s.missing]));
  const lost: string[] = [];
  const back: string[] = [];
  for (const s of next) {
    const before = was.get(s.key);
    if (before === false && s.missing) lost.push(s.label);
    else if (before === true && !s.missing) back.push(s.label);
  }
  return { lost, back };
}
