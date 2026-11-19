interface FullRun {
  conclusion: string;
  event: string;
  id: number;
  head_sha: string;
}

export function provesFullTree(
  run: FullRun,
  tree: string,
  result: unknown,
  expectedTree: string,
): boolean;
export function findFullTreeProof(
  repo: string,
  expectedTree: string,
): (FullRun & { html_url: string }) | null;
