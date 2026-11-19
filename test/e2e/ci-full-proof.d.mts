interface FullRun {
  conclusion: string;
  event: string;
  id: number;
  head_sha: string;
  head_branch: string;
  display_title: string;
  head_commit: { tree_id: string };
}

export function provesFullTree(run: FullRun, result: unknown, tree: string): boolean;
export function findFullTreeProof(
  repo: string,
  tree: string,
): (FullRun & { html_url: string }) | null;

interface ReleaseRun extends FullRun {
  path: string;
  run_attempt: number;
  head_repository: { full_name: string };
}

export function cleanFullResult(result: unknown): boolean;
export function provesReleaseTree(
  run: ReleaseRun,
  result: unknown,
  scope: { repo: string; tree: string },
): boolean;
export function findReleaseTreeProof(
  repo: string,
  tree: string,
): (ReleaseRun & { html_url: string }) | null;
