import { describe, expect, it } from 'vitest';
import { provesFullTree } from '../e2e/ci-full-proof.mjs';

describe('full-tree evidence', () => {
  const run = { id: 42, head_sha: 'tested', conclusion: 'success', event: 'workflow_dispatch' };
  const result = {
    runId: 42,
    sha: 'tested',
    selection: 'full',
    status: 'passed',
    results: [{ status: 'PASS' }],
  };

  it('accepts a successful full run on the same tree', () => {
    expect(provesFullTree(run, 'tree-a', result, 'tree-a')).toBe(true);
  });

  it('rejects different trees, incorrect provenance, partial selections and retry passes', () => {
    expect(provesFullTree(run, 'tree-a', result, 'tree-b')).toBe(false);
    expect(provesFullTree({ ...run, conclusion: 'failure' }, 'tree-a', result, 'tree-a')).toBe(
      false,
    );
    for (const bad of [
      null,
      { ...result, runId: 7 },
      { ...result, sha: 'different' },
      { ...result, selection: 'affected' },
      { ...result, results: [{ status: 'FLAKY' }] },
      { ...result, results: [] },
    ]) {
      expect(provesFullTree(run, 'tree-a', bad, 'tree-a')).toBe(false);
    }
  });
});
