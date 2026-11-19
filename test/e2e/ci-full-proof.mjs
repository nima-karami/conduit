import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const runGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

function downloadResult(repo, runId, name, gh = runGh) {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-full-proof-'));
  try {
    gh(['run', 'download', String(runId), '-R', repo, '-n', name, '-D', dir]);
    return JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function actionsApi(repo, path, gh = runGh) {
  return JSON.parse(gh(['api', `repos/${repo}/${path}`]));
}

export function cleanFullResult(result) {
  return (
    result?.selection === 'full' &&
    result.status === 'passed' &&
    Array.isArray(result.results) &&
    result.results.some((row) => row.status === 'PASS') &&
    result.results.every(
      (row) =>
        ((row.status === 'PASS' || row.status === 'SKIP') && row.attempts === 1) ||
        (row.status === 'EXCLUDED' && row.attempts === 0),
    )
  );
}

export function provesReleaseTree(run, result, { repo, tree }) {
  return (
    run.path === '.github/workflows/e2e.yml' &&
    run.head_repository?.full_name === repo &&
    run.head_commit?.tree_id === tree &&
    run.conclusion === 'success' &&
    run.run_attempt === 1 &&
    (run.event === 'workflow_dispatch' ||
      (run.event === 'schedule' && run.head_branch === 'main')) &&
    result?.runId === run.id &&
    result.sha === run.head_sha &&
    cleanFullResult(result)
  );
}

export function findReleaseTreeProof(repo, tree, gh = runGh) {
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('Expected a Git tree SHA');
  const name = `e2e-full-${tree}`;
  const pages = JSON.parse(
    gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/actions/artifacts?name=${name}&per_page=100`,
    ]),
  );
  for (const artifact of pages.flatMap((page) => page.artifacts)) {
    if (artifact.expired || artifact.name !== name || !artifact.workflow_run) continue;
    try {
      const run = actionsApi(repo, `actions/runs/${artifact.workflow_run.id}`, gh);
      if (run.run_attempt !== 1 || run.id !== artifact.workflow_run.id) continue;
      const result = downloadResult(repo, run.id, name, gh);
      if (provesReleaseTree(run, result, { repo, tree })) return run;
    } catch (error) {
      console.warn(`Could not read release evidence artifact ${artifact.id}: ${error.message}`);
    }
  }
  return null;
}

export function findFullTreeProof(repo, tree) {
  const { workflow_runs: runs } = actionsApi(
    repo,
    'actions/workflows/e2e.yml/runs?branch=main&event=schedule&status=success&per_page=50',
  );
  for (const run of runs) {
    if (!matchingNightly(run, tree)) continue;
    try {
      const { artifacts } = actionsApi(repo, `actions/runs/${run.id}/artifacts?per_page=100`);
      const available = (name) => artifacts.find((item) => item.name === name && !item.expired);
      const result = available('e2e-result');
      if (!result || !available('e2e-state')) continue;
      if (provesFullTree(run, downloadResult(repo, run.id, result.name), tree)) return run;
    } catch (error) {
      console.warn(`Could not read nightly run ${run.id}: ${error.message}`);
    }
  }
  return null;
}
