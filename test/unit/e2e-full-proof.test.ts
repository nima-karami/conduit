import { describe, expect, it } from 'vitest';
import { provesFullTree } from '../e2e/ci-full-proof.mjs';

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
