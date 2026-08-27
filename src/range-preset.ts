import type { RefEndpoint } from './git-range';

/**
 * The two Review source quick-picks that aren't a single commit (spec 2026-08-27-review-supercharge
 * §2 Lane B). Node-free and git-free — the three primitives are injected, so electron/main.ts stays
 * the only place that spawns, and the decision table is testable on CI's ubuntu.
 *
 * Both presets resolve to SHA endpoints rather than a preset-shaped RefEndpoint: `rangeKey` is the
 * renderer's diff cache key, and a name-shaped endpoint would silently point at different content
 * after a fetch. Shas also pass git:rangeDiff's existing validateCommits path unchanged (§3).
 */

export type RangePreset = 'unpushed' | 'branchPoint';

export interface RangePresetDeps {
  /** `git rev-parse --abbrev-ref @{upstream}` — the upstream's name, or null when unset. */
  upstreamRef(): Promise<string | null>;
  /** `git rev-parse --verify --quiet <ref>^{commit}` — a 40-char sha, or null. */
  revParse(ref: string): Promise<string | null>;
  /** `git merge-base <a> <b>` — a sha, or null when there is no common ancestor. */
  mergeBase(a: string, b: string): Promise<string | null>;
}

export interface ResolvedRange {
  base: RefEndpoint;
  head: RefEndpoint;
}

/** In order. `origin/HEAD` is the symbolic ref a clone gets; the literals cover a remote-less repo.
 *  See spec §12 assumption 9. */
export const DEFAULT_BRANCH_REFS = ['origin/HEAD', 'main', 'master'] as const;

const at = (sha: string): RefEndpoint => ({ kind: 'commit', sha });

export async function resolveRangePreset(
  preset: RangePreset,
  deps: RangePresetDeps,
): Promise<ResolvedRange | { error: string }> {
  const head = await deps.revParse('HEAD');
  if (!head) return { error: 'This branch has no commits yet' };

  if (preset === 'unpushed') {
    const upstream = await deps.upstreamRef();
    const base = upstream ? await deps.revParse(upstream) : null;
    if (!base) return { error: 'This branch has no upstream' };
    // A resolved-but-empty comparison is treated as unresolvable: the row is hidden rather than
    // opening a Review with nothing in it (§12 assumption 4).
    if (base === head) return { error: 'Nothing unpushed' };
    return { base: at(base), head: at(head) };
  }

  for (const ref of DEFAULT_BRANCH_REFS) {
    const sha = await deps.revParse(ref);
    if (!sha) continue;
    const base = await deps.mergeBase(sha, head);
    if (!base) continue;
    if (base === head) return { error: 'This branch has no commits of its own' };
    return { base: at(base), head: at(head) };
  }
  return { error: 'No default branch to compare against' };
}
