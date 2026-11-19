import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanFullResult,
  findReleaseTreeProof,
  findTagTreeProof,
  provesFullTree,
  provesReleaseTree,
  provesTagTree,
} from '../e2e/ci-full-proof.mjs';

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

  it('allows a quarantined failure to authorize a tag without authorizing Release reuse', () => {
    const withQuarantine = {
      ...result,
      results: [...result.results, { status: 'QUARANTINED-FAIL', attempts: 1 }],
    };
    expect(provesTagTree(run, withQuarantine, scope)).toBe(true);
    expect(provesReleaseTree(run, withQuarantine, scope)).toBe(false);
    for (const status of ['FAIL', 'FLAKY', 'TIMEOUT', 'INFRA']) {
      expect(
        provesTagTree(
          run,
          {
            ...result,
            results: [...result.results, { status, attempts: 1 }],
          },
          scope,
        ),
      ).toBe(false);
    }
    expect(
      provesTagTree(
        run,
        {
          ...result,
          results: [...result.results, { status: 'PASS', attempts: 2 }],
        },
        scope,
      ),
    ).toBe(false);
    expect(provesTagTree(run, withQuarantine, { ...scope, tree: 'another-tree' })).toBe(false);
    expect(provesTagTree(run, { ...withQuarantine, selection: 'names' }, scope)).toBe(false);
    expect(
      provesTagTree(
        run,
        {
          ...result,
          results: [...result.results, { status: 'QUARANTINED-FAIL', attempts: 2 }],
        },
        scope,
      ),
    ).toBe(false);
    expect(provesTagTree({ ...run, run_attempt: 2 }, withQuarantine, scope)).toBe(false);
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
          results: [{ status: 'PASS', attempts: 1 }],
        }),
      );
      return '';
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(findReleaseTreeProof(repo, tree, gh)).toEqual(valid);
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('artifact 2'));
    } finally {
      warning.mockRestore();
    }
  });

  it.each([false, true])(
    'tag lookup reports strict versus quarantine evidence (%s)',
    (quarantine) => {
      const prefix = quarantine ? 'e2e-tested' : 'e2e-full';
      const artifactName = `${prefix}-${tree}`;
      const gh = (args: string[]) => {
        if (args.includes('--paginate')) {
          return JSON.stringify([
            {
              artifacts: args.at(-1)?.includes(`name=${artifactName}`)
                ? [{ ...artifact(42), name: artifactName }]
                : [],
            },
          ]);
        }
        if (args[0] === 'api') return JSON.stringify(valid);
        expect(args).toContain(artifactName);
        const results = [{ status: 'PASS', attempts: 1 }];
        if (quarantine) results.push({ status: 'QUARANTINED-FAIL', attempts: 1 });
        writeFileSync(
          join(args[8], 'result.json'),
          JSON.stringify({
            sha: valid.head_sha,
            runId: 42,
            selection: 'full',
            status: 'passed',
            results,
          }),
        );
        return '';
      };
      expect(findTagTreeProof(repo, tree, gh)).toEqual({ run: valid, reuse: !quarantine });
      expect(findReleaseTreeProof(repo, tree, gh)).toEqual(quarantine ? null : valid);
    },
  );

  it('returns no proof for empty storage and exposes a lookup error to the workflow fallback', () => {
    expect(findReleaseTreeProof(repo, tree, () => '[{"artifacts":[]}]')).toBeNull();
    expect(() =>
      findReleaseTreeProof(repo, tree, () => {
        throw new Error('GitHub unavailable');
      }),
    ).toThrow('GitHub unavailable');
  });
});
