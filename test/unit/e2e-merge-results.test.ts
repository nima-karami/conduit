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
    [s('PASS', 'QUARANTINED-FAIL'), 'passed'],
    [s('QUARANTINED-FAIL', 'FLAKY'), 'flaky-passed'],
    [s('QUARANTINED-FAIL', 'FAIL'), 'failed'],
    [s('QUARANTINED-FAIL'), 'failed'],
    [s('QUARANTINED-FAIL', 'SKIP', 'EXCLUDED'), 'failed'],
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

describe('quarantine and nightly history in the report', () => {
  it('links artifacts for a QUARANTINED-FAIL and lists it in the summary', () => {
    const r = mergeResults(
      plan,
      [
        { shard: 1, results: [row('a', 'QUARANTINED-FAIL'), row('b', 'PASS')] },
        { shard: 2, results: [row('c', 'PASS')] },
      ],
      { ...meta, artifactUrls: { 1: 'https://x/artifacts/1' } },
    );
    expect(r.status).toBe('passed');
    expect(r.results[0]).toMatchObject({ name: 'a', artifact: 'https://x/artifacts/1' });
    expect(summaryMarkdown(r)).toContain('1 QUARANTINED-FAIL');
  });

  it('marks a failure the last nightly also had, and it still fails the run', () => {
    const r = mergeResults(
      plan,
      [
        { shard: 1, results: [row('a', 'FAIL'), row('b', 'FAIL')] },
        { shard: 2, results: [row('c', 'PASS')] },
      ],
      { ...meta, lastNightly: { sha: 'feedbeef99', runId: 9, at: 't', failing: ['a', 'c'] } },
    );
    expect(r.status).toBe('failed');
    expect(r.results.find((x) => x.name === 'a')).toMatchObject({ alsoFailingOnNightly: true });
    expect(r.results.find((x) => x.name === 'b')).not.toHaveProperty('alsoFailingOnNightly');
    expect(r.results.find((x) => x.name === 'c')).not.toHaveProperty('alsoFailingOnNightly');
    expect(summaryMarkdown(r)).toContain('also failing on the last nightly (feedbee)');
  });

  it('warns about a quarantine entry older than 14 days, and only about that one', () => {
    const quarantine = {
      scenarios: {
        a: { reason: 'flaky focus', since: '2026-09-10' },
        b: { reason: 'new', since: '2026-09-25' },
      },
    };
    const r = mergeResults(plan, allPass, {
      ...meta,
      quarantine,
      finishedAt: '2026-09-30T08:00:00Z',
    });
    expect(r.warnings).toEqual(['a: quarantined > 14 days (since 2026-09-10) — re-check']);
    expect(summaryMarkdown(r)).toContain('a: quarantined > 14 days (since 2026-09-10) — re-check');
    expect(mergeResults(plan, allPass, meta).warnings).toEqual([]);
  });

  it('carries quarantine candidates into the result and the summary', () => {
    const candidates = [{ name: 'multi-repo', count: 3, last: '2026-09-30T08:00:00.000Z' }];
    const r = mergeResults(plan, allPass, { ...meta, quarantineCandidates: candidates });
    expect(r.quarantineCandidates).toEqual(candidates);
    expect(summaryMarkdown(r)).toContain('Quarantine candidates');
    expect(summaryMarkdown(r)).toContain('multi-repo: FLAKY 3');
    expect(summaryMarkdown(mergeResults(plan, allPass, meta))).not.toContain('Quarantine');
  });
});
