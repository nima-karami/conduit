import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function matchingNightly(run, tree) {
  return (
    run.conclusion === 'success' &&
    run.event === 'schedule' &&
    run.head_branch === 'main' &&
    run.display_title === 'e2e full schedule' &&
    run.head_commit?.tree_id === tree
  );
}

export function provesFullTree(run, result, tree) {
  return (
    matchingNightly(run, tree) &&
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

function downloadResult(repo, artifactId) {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-full-proof-'));
  try {
    const file = join(dir, 'result.zip');
    const zip = execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${artifactId}/zip`]);
    writeFileSync(file, zip);
    return JSON.parse(execFileSync('unzip', ['-p', file, 'result.json']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function findFullTreeProof(repo, tree) {
  const api = (path) =>
    JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${path}`], { encoding: 'utf8' }));
  const { workflow_runs: runs } = api(
    'actions/workflows/e2e.yml/runs?branch=main&event=schedule&status=success&per_page=50',
  );
  for (const run of runs) {
    if (!matchingNightly(run, tree)) continue;
    try {
      const { artifacts } = api(`actions/runs/${run.id}/artifacts?per_page=100`);
      const available = (name) => artifacts.find((item) => item.name === name && !item.expired);
      const result = available('e2e-result');
      if (!result || !available('e2e-state')) continue;
      if (provesFullTree(run, downloadResult(repo, result.id), tree)) return run;
    } catch (error) {
      console.warn(`Could not read nightly run ${run.id}: ${error.message}`);
    }
  }
  return null;
}
