import { describe, expect, it } from 'vitest';
import {
  applyExclusions,
  classify,
  finalStatus,
  parseRunnerArgs,
  resolveSelection,
} from '../e2e/smoke-select.mjs';

const stems = ['cwd', 'durability', 'quit-guard'];
const local = { stems, ci: false, localFull: false };

describe('resolveSelection (local single instance)', () => {
  it('runs exactly one named scenario locally', () => {
    expect(resolveSelection({ ...local, names: ['cwd'] })).toEqual({ names: ['cwd'] });
  });

  it('refuses two names locally and prints the remote equivalent', () => {
    const r = resolveSelection({ ...local, names: ['quit-guard', 'cwd'] });
    expect(r).toMatchObject({ exit: 2 });
    expect('message' in r && r.message).toContain('npm run e2e:remote -- cwd quit-guard');
  });

  it('refuses no names locally and points at --full', () => {
    const r = resolveSelection({ ...local, names: [] });
    expect(r).toMatchObject({ exit: 2 });
    expect('message' in r && r.message).toContain('npm run e2e:remote -- --full');
  });

  it('matches names exactly, never as substrings', () => {
    expect(resolveSelection({ ...local, names: ['dura'] })).toMatchObject({ exit: 1 });
  });

  it('the escape hatch runs the whole suite behind a banner', () => {
    const r = resolveSelection({ ...local, names: [], localFull: true });
    expect(r).toMatchObject({ names: stems });
    expect('banner' in r && r.banner).toContain('CONDUIT_E2E_LOCAL_FULL');
  });

  it('on CI any number of names runs', () => {
    expect(resolveSelection({ ...local, ci: true, names: ['quit-guard', 'cwd'] })).toEqual({
      names: ['cwd', 'quit-guard'],
    });
  });
});

describe('classify', () => {
  it.each([
    [{ status: 0 }, 'PASS'],
    [{ status: 0, output: '[x] SKIP — no pwsh' }, 'SKIP'],
    [{ status: 124 }, 'TIMEOUT'],
    [{ status: null, errorCode: 'ETIMEDOUT' }, 'TIMEOUT'],
    [{ status: null, signal: 'SIGTERM' }, 'TIMEOUT'],
    [{ status: 1 }, 'FAIL'],
    [{ status: 2 }, 'FAIL'],
    [{ status: 3 }, 'FAIL'],
  ])('%j → %s', (r, expected) => {
    expect(classify(r)).toBe(expected);
  });
});

describe('finalStatus', () => {
  it('a failure that passes on retry is FLAKY; a failed retry keeps its own status', () => {
    expect(finalStatus('PASS')).toBe('PASS');
    expect(finalStatus('FAIL', 'PASS')).toBe('FLAKY');
    expect(finalStatus('TIMEOUT', 'FAIL')).toBe('FAIL');
  });
});

describe('parseRunnerArgs / applyExclusions', () => {
  it('parses names and flags; the old --exact flag is gone', () => {
    expect(parseRunnerArgs(['cwd', '--json', 'o.json', '--retry', '--artifacts', 'a'])).toEqual({
      names: ['cwd'],
      namesFile: null,
      json: 'o.json',
      artifacts: 'a',
      retry: true,
    });
    expect(parseRunnerArgs(['--json'])).toHaveProperty('error');
    expect(parseRunnerArgs(['--exact', 'cwd'])).toHaveProperty('error');
  });

  it('keeps excluded names off the runner with their reason', () => {
    expect(applyExclusions(['a', 'b'], { b: 'focus' })).toEqual({
      run: ['a'],
      excluded: { b: 'focus' },
    });
  });
});
