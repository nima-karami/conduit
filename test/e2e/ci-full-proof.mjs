import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function provesFullTree(run, tree, result, expectedTree) {
  return (
    run.conclusion === 'success' &&
    (run.event === 'workflow_dispatch' || run.event === 'schedule') &&
    tree === expectedTree &&
    result?.runId === run.id &&
    result.sha === run.head_sha &&
    result.selection === 'full' &&
    result.status === 'passed' &&
    Array.isArray(result.results) &&
    result.results.length > 0 &&
    result.results.every((row) =>
      ['PASS', 'SKIP', 'EXCLUDED', 'QUARANTINED-FAIL'].includes(row.status),
    )
  );
}

export function findFullTreeProof(repo, expectedTree) {
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });
  const api = (path) => JSON.parse(gh('api', `repos/${repo}/${path}`));
  const { workflow_runs: runs } = api('actions/workflows/e2e.yml/runs?status=success&per_page=50');
  const trees = new Map();
  for (const run of runs) {
    if (!/^e2e full \S+$/.test(run.display_title)) continue;
    if (!trees.has(run.head_sha)) {
      trees.set(run.head_sha, api(`git/commits/${run.head_sha}`).tree.sha);
    }
    const tree = trees.get(run.head_sha);
    if (tree !== expectedTree) continue;

    const { artifacts } = api(`actions/runs/${run.id}/artifacts?name=e2e-result`);
    const artifact = artifacts.find((item) => !item.expired);
    if (!artifact) continue;
    const zip = execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${artifact.id}/zip`]);
    const dir = mkdtempSync(join(tmpdir(), 'conduit-full-proof-'));
    try {
      const file = join(dir, 'result.zip');
      writeFileSync(file, zip);
      const result = JSON.parse(execFileSync('unzip', ['-p', file, 'result.json']));
      if (provesFullTree(run, tree, result, expectedTree)) return run;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return null;
}
