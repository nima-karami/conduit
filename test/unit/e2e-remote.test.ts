import { describe, expect, it } from 'vitest';
import {
  exitCodeFor,
  finalStatus,
  formatResults,
  makeNonce,
  matchInFlight,
  parseArgs,
  parseTitle,
  runState,
  selectionKey,
} from '../../tools/e2e-remote-lib.mjs';

const run = (over: Partial<{ displayTitle: string; status: string; headSha: string }>) => ({
  databaseId: 1,
  url: 'https://x/runs/1',
  displayTitle: 'e2e full full.aaaa',
  status: 'in_progress',
  headSha: 'sha1',
  ...over,
});

describe('parseArgs', () => {
  it('parses --full and names', () => {
    expect(parseArgs(['--full', '--no-wait'])).toMatchObject({
      full: true,
      wait: false,
      verify: true,
    });
    expect(parseArgs(['b', 'a', 'a', '--shards', '4'])).toMatchObject({
      names: ['a', 'b'],
      shards: 4,
    });
  });

  it('--affected is a clear not-until-v1 error', () => {
    expect(parseArgs(['--affected'])).toEqual({
      error: expect.stringContaining('not available until v1'),
    });
  });

  it('needs a selection, and not both kinds', () => {
    expect(parseArgs([])).toHaveProperty('error');
    expect(parseArgs(['--full', 'cwd'])).toHaveProperty('error');
    expect(parseArgs(['--shards', 'x', 'cwd'])).toHaveProperty('error');
  });
});

describe('run correlation', () => {
  it('the nonce carries the selection key through the run title', () => {
    const key = selectionKey({ full: false, names: ['a', 'b'], verify: true });
    expect(key).toMatch(/^n-[0-9a-f]{8}$/);
    expect(selectionKey({ full: true, names: [], verify: false })).toBe('full-nv');
    expect(parseTitle(`e2e names ${makeNonce(key, 'deadbeef')}`)).toEqual({
      selection: 'names',
      nonce: `${key}.deadbeef`,
      selKey: key,
    });
    expect(parseTitle('something else')).toBeNull();
  });

  it('same sha and selection → attach', () => {
    const r = run({ displayTitle: 'e2e names n-12345678.aaaa' });
    expect(matchInFlight([r], { sha: 'sha1', selKey: 'n-12345678', full: false })).toEqual({
      attach: r,
    });
  });

  it('--full with a full run in flight at another sha → waitFor', () => {
    const r = run({ headSha: 'other' });
    expect(matchInFlight([r], { sha: 'sha1', selKey: 'full', full: true })).toEqual({ waitFor: r });
  });

  it('names at a different sha → dispatch; completed runs are ignored', () => {
    const r = run({ displayTitle: 'e2e names n-12345678.aaaa', headSha: 'other' });
    expect(matchInFlight([r], { sha: 'sha1', selKey: 'n-12345678', full: false })).toEqual({
      dispatch: true,
    });
    const done = run({ status: 'completed' });
    expect(matchInFlight([done], { sha: 'sha1', selKey: 'full', full: true })).toEqual({
      dispatch: true,
    });
  });
});

describe('runState', () => {
  const job = (name: string, status: string) => ({ name, status });
  it('maps a canned gh run view to the spec states', () => {
    expect(runState({ status: 'queued' })).toBe('queued');
    expect(runState({ status: 'in_progress', jobs: [job('prepare', 'in_progress')] })).toBe(
      'preparing',
    );
    expect(
      runState({
        status: 'in_progress',
        jobs: [
          job('prepare', 'completed'),
          job('shard 1', 'completed'),
          job('shard 2', 'in_progress'),
        ],
      }),
    ).toBe('running 1/2');
    expect(
      runState({
        status: 'in_progress',
        jobs: [
          job('prepare', 'completed'),
          job('shard 1', 'completed'),
          job('report', 'in_progress'),
        ],
      }),
    ).toBe('reporting');
    expect(
      runState({
        status: 'queued',
        jobs: [job('prepare', 'completed'), job('shard 1', 'completed'), job('report', 'queued')],
      }),
    ).toBe('reporting');
    expect(runState({ status: 'completed' })).toBe('completed');
  });
});

describe('verdict', () => {
  it('a cancelled conclusion beats result.json; a missing result is infra', () => {
    expect(finalStatus('cancelled', { status: 'passed' })).toBe('cancelled');
    expect(finalStatus('failure', null)).toBe('infra-error');
    expect(finalStatus('failure', { status: 'failed' })).toBe('failed');
  });

  it.each([
    ['passed', 0],
    ['flaky-passed', 0],
    ['failed', 1],
    ['infra-error', 2],
    ['cancelled', 2],
    ['timed-out', 2],
  ])('%s → exit %i', (status, code) => {
    expect(exitCodeFor(status)).toBe(code);
  });

  it('prints run-smoke style lines, exclusions with reasons, and the INFRA re-run line', () => {
    const out = formatResults({
      status: 'failed',
      sha: 'abcdef123',
      verify: 'success',
      rerun: 'npm run e2e:remote -- c (at abcdef1)',
      results: [
        { name: 'a', status: 'PASS', seconds: 12.3, shard: 3 },
        { name: 'b', status: 'FAIL', seconds: 4, shard: 1, artifact: 'https://art' },
        { name: 'z', status: 'EXCLUDED', seconds: 0, shard: null, reason: 'focus' },
      ],
    });
    expect(out).toContain('  a ... ✓ PASS (12.3s) [s3]');
    expect(out).toContain('  b ... ✗ FAIL (4s) [s1]');
    expect(out).toContain('  z ... - EXCLUDED (0s) — focus');
    expect(out).toContain('artifacts: https://art');
    expect(out).toContain('re-run the INFRA scenarios: npm run e2e:remote -- c (at abcdef1)');
  });
});
