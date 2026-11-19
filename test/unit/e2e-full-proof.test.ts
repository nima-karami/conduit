import { describe, expect, it } from 'vitest';
import { cleanFullResult, provesFullTree, provesReleaseTree } from '../e2e/ci-full-proof.mjs';

describe('nightly full-tree evidence', () => {
  const tree = 'tree-a';
  const run = {
    id: 42,
    head_sha: 'tested',
    head_branch: 'main',
    conclusion: 'success',
    event: 'schedule',
    display_title: 'e2e full schedule',
    head_commit: { tree_id: tree },
  };
  const result = {
    runId: 42,
    sha: 'tested',
    selection: 'full',
    status: 'passed',
    results: [{ status: 'PASS' }],
  };

  it('accepts a successful scheduled full run on the same tree, including quarantined failures', () => {
    expect(provesFullTree(run, result, tree)).toBe(true);
    expect(
      provesFullTree(run, { ...result, results: [{ status: 'QUARANTINED-FAIL' }] }, tree),
    ).toBe(true);
  });

  it('rejects runs from different trees, titles, events or branches', () => {
    expect(provesFullTree(run, result, 'tree-b')).toBe(false);
    for (const override of [
      { conclusion: 'failure' },
      { event: 'push' },
      { event: 'workflow_dispatch' },
      { head_branch: 'release' },
      { display_title: 'e2e names schedule' },
    ]) {
      expect(provesFullTree({ ...run, ...override }, result, tree)).toBe(false);
    }
  });

  it('rejects partial results, failures and retry passes', () => {
    for (const bad of [
      null,
      { ...result, runId: 7 },
      { ...result, sha: 'different' },
      { ...result, selection: 'affected' },
      { ...result, status: 'failed' },
      { ...result, results: [{ status: 'FLAKY' }] },
      { ...result, results: [] },
    ]) {
      expect(provesFullTree(run, bad, tree)).toBe(false);
    }
  });
});

describe('release full-tree evidence', () => {
  const scope = { repo: 'owner/repo', tree: 'proven-tree' };
  const run = {
    id: 42,
    path: '.github/workflows/e2e.yml',
    event: 'workflow_dispatch',
    conclusion: 'success',
    head_repository: { full_name: scope.repo },
    head_commit: { tree_id: scope.tree },
    head_branch: 'ci/e2e/result',
    head_sha: 'tested-sha',
    display_title: 'e2e full key',
    run_attempt: 1,
  };
  const result = {
    runId: 42,
    sha: 'tested-sha',
    selection: 'full',
    status: 'passed',
    results: [
      { status: 'PASS', attempts: 1 },
      { status: 'SKIP', attempts: 1 },
      { status: 'EXCLUDED', attempts: 0 },
    ],
  };

  it('accepts a different commit with the exact tested tree and clean first-attempt proof', () => {
    expect(cleanFullResult(result)).toBe(true);
    expect(provesReleaseTree(run, result, scope)).toBe(true);
    expect(
      provesReleaseTree({ ...run, event: 'schedule', head_branch: 'main' }, result, scope),
    ).toBe(true);
  });

  it('rejects different workflows, repositories and trees, reruns and unsuccessful conclusions', () => {
    for (const override of [
      { path: '.github/workflows/release.yml' },
      { head_repository: { full_name: 'fork/repo' } },
      { head_commit: { tree_id: 'another-tree' } },
      { run_attempt: 2 },
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { event: 'schedule', head_branch: 'feature' },
      { event: 'push' },
    ]) {
      expect(provesReleaseTree({ ...run, ...override }, result, scope)).toBe(false);
    }
  });

  it('rejects missing and uncorrelated results, partial runs, and any failures or retries', () => {
    for (const bad of [
      null,
      { ...result, runId: 7 },
      { ...result, sha: 'another-sha' },
      { ...result, selection: 'names' },
      { ...result, status: 'failed' },
      { ...result, results: [] },
      { ...result, results: [{ status: 'PASS', attempts: 2 }] },
      ...['FAIL', 'FLAKY', 'TIMEOUT', 'INFRA', 'QUARANTINED-FAIL'].map((status) => ({
        ...result,
        results: [...result.results, { status, attempts: 1 }],
      })),
    ]) {
      expect(provesReleaseTree(run, bad, scope)).toBe(false);
    }
  });
});
