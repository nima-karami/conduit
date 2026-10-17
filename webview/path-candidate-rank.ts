/**
 * Renderer-side ranking of a path token's candidates and the click decision (spec
 * 2026-10-16-terminal-path-links §3.3). Runs after the cache, so the session-local last pick never
 * gets cached. Pure.
 */
import { folderKey } from '../src/folder-key';
import type { ResolveRoot } from '../src/path-link-roots';
import type { CandidateStrength, PathCandidate } from '../src/path-resolve';

export interface RankInputs {
  roots: readonly ResolveRoot[];
  lastPickRepoRoot?: string;
}

export type RankKey = 'strength' | 'lastPick' | 'rootGroup' | 'rootOrder' | 'shorter';

/** No context-root key: the T7.2 measurement failed the plan's bar, and after rootOrder it could
 *  never reorder distinct roots, so it is the picker's "working here" label only (see
 *  docs/runs/2026-10-16-terminal-path-links/report.md "Context-root measurement (T7.2)"). */
export const RANK_KEYS: readonly RankKey[] = [
  'strength',
  'lastPick',
  'rootGroup',
  'rootOrder',
  'shorter',
];

const STRENGTH: Record<CandidateStrength, number> = { 'exact-cwd': 0, 'exact-root': 1, suffix: 2 };
const GROUP: Record<ResolveRoot['kind'], number> = {
  home: 0,
  'cwd-repo': 0,
  attached: 1,
  nested: 2,
  worktree: 2,
};
const OUTSIDE_GROUP = 3;

type Comparator = (a: PathCandidate, b: PathCandidate) => number;

function comparators(inputs: RankInputs): Record<RankKey, Comparator> {
  const pickKey = inputs.lastPickRepoRoot ? folderKey(inputs.lastPickRepoRoot) : undefined;
  const flag =
    (hit: (c: PathCandidate) => boolean): Comparator =>
    (a, b) =>
      Number(hit(b)) - Number(hit(a));
  const group = (c: PathCandidate) =>
    c.rootIdx < 0 ? OUTSIDE_GROUP : (GROUP[inputs.roots[c.rootIdx]?.kind] ?? OUTSIDE_GROUP);
  const order = (c: PathCandidate) => (c.rootIdx < 0 ? Number.MAX_SAFE_INTEGER : c.rootIdx);
  return {
    strength: (a, b) => STRENGTH[a.strength] - STRENGTH[b.strength],
    lastPick: flag((c) => pickKey !== undefined && folderKey(c.repoRoot) === pickKey),
    rootGroup: (a, b) => group(a) - group(b),
    rootOrder: (a, b) => order(a) - order(b),
    shorter: (a, b) =>
      a.relToRoot.length - b.relToRoot.length || a.relToRoot.localeCompare(b.relToRoot),
  };
}

/** Stable; never mutates its input. */
export function rankCandidates(
  cands: readonly PathCandidate[],
  inputs: RankInputs,
): PathCandidate[] {
  const by = comparators(inputs);
  return [...cands].sort((a, b) => {
    for (const key of RANK_KEYS) {
      const d = by[key](a, b);
      if (d !== 0) return d;
    }
    return 0;
  });
}

export type ClickAction =
  | { kind: 'none' }
  | { kind: 'open'; cand: PathCandidate }
  | { kind: 'pick' };

/** An exact-cwd hit opens directly ("a terminal is a view of its cwd"), as does a single
 *  candidate; anything else is ambiguous and opens the picker (spec §2.3 step 5). */
export function chooseClickAction(cands: readonly PathCandidate[]): ClickAction {
  if (cands.length === 0) return { kind: 'none' };
  const cwd = cands.find((c) => c.strength === 'exact-cwd');
  if (cwd) return { kind: 'open', cand: cwd };
  if (cands.length === 1) return { kind: 'open', cand: cands[0] };
  return { kind: 'pick' };
}
