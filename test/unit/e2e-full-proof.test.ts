import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  eligibleFullResult,
  findReleaseTreeProof,
  provesFullTree,
  provesReleaseTree,
} from '../e2e/ci-full-proof.mjs';

const inventory = new Map([
  ['cwd', 'run'],
  ['platform', 'run'],
  ['excluded', 'excluded'],
  ['scrollback-inrun', 'quarantined'],
] as const);

const fullRows = [
  { name: 'cwd', status: 'PASS', attempts: 1 },
  { name: 'platform', status: 'SKIP', attempts: 1 },
  { name: 'excluded', status: 'EXCLUDED', attempts: 0 },
  { name: 'scrollback-inrun', status: 'QUARANTINED-FAIL', attempts: 1 },
];

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
    results: fullRows,
  };
  const proves = (candidate: typeof run, evidence: unknown, expected = scope) =>
    provesReleaseTree(candidate, evidence, expected, inventory);

  it.each(['PASS', 'QUARANTINED-FAIL'])(
    'accepts complete evidence with a declared quarantine status of %s',
    (status) => {
      const results = fullRows.map((row) =>
        row.name === 'scrollback-inrun' ? { ...row, status } : row,
      );
      const evidence = { ...result, results };
      expect(eligibleFullResult(evidence, inventory)).toBe(true);
      expect(proves(run, evidence)).toBe(true);
      expect(proves({ ...run, event: 'schedule', head_branch: 'main' }, evidence)).toBe(true);
    },
  );

  it('rejects missing, extra, duplicate or unknown scenario rows', () => {
    for (const results of [
      fullRows.slice(1),
      [...fullRows, fullRows[0]],
      [fullRows[0], ...fullRows.slice(0, 3)],
      [{ ...fullRows[0], name: 'unrecognized' }, ...fullRows.slice(1)],
      [null, ...fullRows.slice(1)],
    ]) {
      expect(proves(run, { ...result, results })).toBe(false);
    }
  });

  it('rejects undeclared quarantine, wrong exclusions, and non-first attempts', () => {
    for (const [index, patch] of [
      [0, { status: 'QUARANTINED-FAIL' }],
      [0, { attempts: 2 }],
      [0, { attempt: 1 }],
      [1, { status: 'EXCLUDED', attempts: 0 }],
      [1, { attempts: 2 }],
      [2, { status: 'PASS', attempts: 1 }],
      [2, { attempts: 1 }],
      [3, { attempts: 2 }],
    ] as const) {
      const results = fullRows.map((row, i) => (i === index ? { ...row, ...patch } : row));
      expect(proves(run, { ...result, results })).toBe(false);
    }
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
      expect(proves({ ...run, ...override }, result)).toBe(false);
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
      ...['FAIL', 'FLAKY', 'TIMEOUT', 'INFRA'].map((status) => ({
        ...result,
        results: [{ ...fullRows[0], status }, ...fullRows.slice(1)],
      })),
    ]) {
      expect(proves(run, bad)).toBe(false);
    }
  });
});

describe('release evidence lookup', () => {
  const repo = 'owner/repo';
  const tree = 'a'.repeat(40);
  const name = `e2e-full-${tree}`;
  const artifact = (id: number) => ({ id, name, expired: false, workflow_run: { id } });
  const valid = {
    id: 42,
    path: '.github/workflows/e2e.yml',
    event: 'workflow_dispatch',
    conclusion: 'success',
    head_repository: { full_name: repo },
    head_commit: { tree_id: tree },
    head_sha: 'tested-sha',
    run_attempt: 1,
  };

  it('continues past expired, missing and invalid artifacts on earlier pages', () => {
    const gh = vi.fn((args: string[]) => {
      if (args.includes('--paginate')) {
        expect(args).toContain('--slurp');
        return JSON.stringify([
          { artifacts: [{ ...artifact(1), expired: true }, artifact(2), artifact(3)] },
          { artifacts: [artifact(42)] },
        ]);
      }
      if (args[0] === 'api') {
        if (args[1].endsWith('/2')) throw new Error('artifact run no longer exists');
        if (args[1].endsWith('/3')) return JSON.stringify({ ...valid, id: 3, run_attempt: 2 });
        if (args[1].endsWith('/42')) return JSON.stringify(valid);
      }
      expect(args.slice(0, 7)).toEqual(['run', 'download', '42', '-R', repo, '-n', name]);
      writeFileSync(
        join(args[8], 'result.json'),
        JSON.stringify({
          sha: valid.head_sha,
          runId: 42,
          selection: 'full',
          status: 'passed',
          results: fullRows,
        }),
      );
      return '';
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(findReleaseTreeProof(repo, tree, gh, inventory)).toEqual(valid);
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('artifact 2'));
    } finally {
      warning.mockRestore();
    }
  });

  it('returns no proof for empty storage and exposes a lookup error to the workflow fallback', () => {
    expect(findReleaseTreeProof(repo, tree, () => '[{"artifacts":[]}]')).toBeNull();
    expect(() =>
      findReleaseTreeProof(repo, tree, () => {
        throw new Error('GitHub unavailable');
      }),
    ).toThrow('GitHub unavailable');
  });
});
