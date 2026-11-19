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
