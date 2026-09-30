import { describe, expect, it } from 'vitest';
import { mergeResults, runStatus, summaryMarkdown } from '../e2e/ci-merge-results.mjs';

const plan = {
  shards: [
    { index: 0, names: ['a', 'b'] },
    { index: 1, names: ['c'] },
  ],
};
const meta = { sha: 'abcdef1234567', nonce: 'full.1234', selection: 'full' };
const row = (name: string, status: string) => ({ name, status, seconds: 1 });
const s = (...statuses: string[]) => statuses.map((status, i) => ({ name: `n${i}`, status }));
const allPass = [
  { shard: 1, results: [row('a', 'PASS'), row('b', 'PASS')] },
  { shard: 2, results: [row('c', 'PASS')] },
];

describe('mergeResults', () => {
  it('marks a planned name with no result as INFRA', () => {
    const r = mergeResults(
      plan,
      [{ shard: 1, results: [row('a', 'PASS'), row('b', 'PASS')] }],
      meta,
    );
    expect(r.results.find((x) => x.name === 'c')).toMatchObject({ status: 'INFRA', shard: 2 });
    expect(r.status).toBe('infra-error');
    expect(r.rerun).toBe('npm run e2e:remote -- c (at abcdef1)');
  });

  it('a FAIL beats INFRA, and the INFRA re-run line is still given', () => {
    const r = mergeResults(
      plan,
      [{ shard: 1, results: [row('a', 'FAIL'), row('b', 'PASS')] }],
      meta,
    );
    expect(r.status).toBe('failed');
    expect(r.rerun).toBe('npm run e2e:remote -- c (at abcdef1)');
  });

  it('links the shard artifact only on non-green rows', () => {
    const r = mergeResults(
      plan,
      [
        { shard: 1, results: [row('a', 'FAIL'), row('b', 'PASS')] },
        { shard: 2, results: [row('c', 'FLAKY')] },
      ],
      { ...meta, artifactUrls: { 1: 'u1', 2: 'u2' } },
    );
    expect(r.results.map((x) => [x.name, x.artifact])).toEqual([
      ['a', 'u1'],
      ['b', undefined],
      ['c', 'u2'],
    ]);
    expect(r.status).toBe('failed');
  });

  it('lists exclusions as EXCLUDED with their reason, neutral to the verdict', () => {
    const r = mergeResults(plan, allPass, { ...meta, excluded: { z: 'needs OS focus' } });
    expect(r.status).toBe('passed');
    expect(r.results.at(-1)).toMatchObject({
      name: 'z',
      status: 'EXCLUDED',
      reason: 'needs OS focus',
    });
    expect(summaryMarkdown(r)).toContain(
      '| z | EXCLUDED | 0 | 0 |  | needs OS focus; run locally: `npm run e2e -- z` |',
    );
  });

  it('a failed verify job fails an otherwise green run', () => {
    const r = mergeResults(plan, allPass, { ...meta, verify: 'failure' });
    expect(r.status).toBe('failed');
    expect(summaryMarkdown(r)).toContain('verify job: **failure**');
  });
});

describe('runStatus', () => {
  it.each([
    [s(), 'passed'],
    [s('PASS', 'TIMEOUT', 'INFRA'), 'failed'],
    [s('PASS', 'INFRA'), 'infra-error'],
    [s('SKIP', 'SKIP'), 'failed'],
    [s('SKIP', 'EXCLUDED'), 'failed'],
    [s('EXCLUDED'), 'failed'],
    [s('PASS', 'FLAKY', 'SKIP'), 'flaky-passed'],
    [s('PASS', 'SKIP', 'EXCLUDED'), 'passed'],
  ])('%j → %s', (results, expected) => {
    expect(runStatus(results)).toBe(expected);
  });

  it.each(['cancelled', 'timed_out', 'failure'])(
    'a requested verify that ended %s fails the run',
    (verify) => {
      expect(runStatus(s('PASS'), { verify })).toBe('failed');
    },
  );

  it('a failed prepare is infra, but never masks a failed verify', () => {
    expect(runStatus([], { prepare: 'failure', verify: 'success' })).toBe('infra-error');
    expect(runStatus([], { prepare: 'failure', verify: 'failure' })).toBe('failed');
  });

  it('a successful or skipped verify leaves the scenario verdict alone', () => {
    expect(runStatus(s('PASS'), { verify: 'success' })).toBe('passed');
    expect(runStatus(s('FLAKY'), { verify: 'skipped' })).toBe('flaky-passed');
  });
});
