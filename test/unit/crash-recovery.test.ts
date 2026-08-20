import { describe, expect, it } from 'vitest';
import { decideCrashRecovery, MAX_RELOADS, RELOAD_WINDOW_MS } from '../../src/crash-recovery';

const NOW = 1_000_000_000;

describe('decideCrashRecovery — non-crash reasons', () => {
  it.each(['clean-exit', 'killed'])('ignores %s', (reason) => {
    expect(decideCrashRecovery(reason, [], NOW)).toEqual({ action: 'ignore', reloads: [] });
  });

  it('leaves the reload history untouched when ignoring (no budget is spent)', () => {
    const prior = [NOW - 10];
    expect(decideCrashRecovery('killed', prior, NOW).reloads).toEqual(prior);
  });

  it('ignores even after the budget is exhausted — teardown is never a give-up', () => {
    const prior = [NOW - 3, NOW - 2, NOW - 1];
    expect(decideCrashRecovery('clean-exit', prior, NOW).action).toBe('ignore');
  });
});

describe('decideCrashRecovery — crash reasons', () => {
  it.each(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure'])(
    'reloads on %s',
    (reason) => {
      expect(decideCrashRecovery(reason, [], NOW)).toEqual({ action: 'reload', reloads: [NOW] });
    },
  );

  it('reloads on an unknown reason — a black window is worse than a spare reload', () => {
    expect(decideCrashRecovery('some-future-reason', [], NOW).action).toBe('reload');
  });

  it('appends `now` to the history it returns', () => {
    const at = NOW - RELOAD_WINDOW_MS / 2;
    expect(decideCrashRecovery('crashed', [at], NOW).reloads).toEqual([at, NOW]);
  });
});

describe('decideCrashRecovery — the reload budget', () => {
  it(`allows exactly ${MAX_RELOADS} reloads in the window`, () => {
    let reloads: number[] = [];
    for (let i = 0; i < MAX_RELOADS; i++) {
      const d = decideCrashRecovery('crashed', reloads, NOW + i);
      expect(d.action).toBe('reload');
      reloads = d.reloads;
    }
    expect(reloads).toHaveLength(MAX_RELOADS);
  });

  it('gives up on the crash after the budget is spent', () => {
    const prior = [NOW - 3, NOW - 2, NOW - 1];
    expect(decideCrashRecovery('crashed', prior, NOW)).toEqual({
      action: 'give-up',
      reloads: prior,
    });
  });

  it('stays given-up while the stale entries are still inside the window', () => {
    const prior = [NOW - 3, NOW - 2, NOW - 1];
    const first = decideCrashRecovery('oom', prior, NOW);
    expect(decideCrashRecovery('oom', first.reloads, NOW + 1).action).toBe('give-up');
  });
});

describe('decideCrashRecovery — sliding window pruning', () => {
  it('drops entries older than the window', () => {
    const stale = NOW - RELOAD_WINDOW_MS - 1;
    const d = decideCrashRecovery('crashed', [stale, NOW - 1], NOW);
    expect(d.reloads).toEqual([NOW - 1, NOW]);
  });

  it('an entry exactly `RELOAD_WINDOW_MS` old has left the window', () => {
    const edge = NOW - RELOAD_WINDOW_MS;
    expect(decideCrashRecovery('crashed', [edge], NOW).reloads).toEqual([NOW]);
  });

  it('an entry one ms newer than the edge is still inside it', () => {
    const inside = NOW - RELOAD_WINDOW_MS + 1;
    expect(decideCrashRecovery('crashed', [inside], NOW).reloads).toEqual([inside, NOW]);
  });

  it('recovers the budget once the burst ages out', () => {
    const burst = [NOW - 3, NOW - 2, NOW - 1];
    expect(decideCrashRecovery('crashed', burst, NOW).action).toBe('give-up');
    const later = NOW + RELOAD_WINDOW_MS;
    const d = decideCrashRecovery('crashed', burst, later);
    expect(d).toEqual({ action: 'reload', reloads: [later] });
  });

  it('prunes on the give-up path too, so the history cannot grow unbounded', () => {
    const stale = [NOW - RELOAD_WINDOW_MS - 5, NOW - RELOAD_WINDOW_MS - 4];
    const recent = [NOW - 3, NOW - 2, NOW - 1];
    expect(decideCrashRecovery('crashed', [...stale, ...recent], NOW).reloads).toEqual(recent);
  });

  it('does not mutate the array it was given', () => {
    const prior = [NOW - 1];
    const copy = [...prior];
    decideCrashRecovery('crashed', prior, NOW);
    expect(prior).toEqual(copy);
  });
});
