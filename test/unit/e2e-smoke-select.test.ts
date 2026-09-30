import { describe, expect, it } from 'vitest';
import {
  applyExclusions,
  applyQuarantine,
  classify,
  finalStatus,
  isGreen,
  KILL_TIMER_LOCK_CAP_MS,
  killTimerOnLine,
  killTimerStart,
  lockWaitMsFromLine,
  orphanVictims,
  parseRunnerArgs,
  profilePrefix,
  RUN_MARKER,
  resolveSelection,
  watchdogDelayMs,
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
    [{ status: null, signal: 'SIGTERM' }, 'TIMEOUT'],
    [{ status: 1 }, 'FAIL'],
    [{ status: 2 }, 'FAIL'],
    [{ status: 3 }, 'FAIL'],
    [{ status: null, signal: 'SIGTERM', lockTimeout: true }, 'LOCK-TIMEOUT'],
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
      quarantine: null,
    });
    expect(parseRunnerArgs(['cwd', '--quarantine', 'q.json'])).toMatchObject({
      quarantine: 'q.json',
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

describe('applyQuarantine', () => {
  const q = { scenarios: { flaky: { reason: 'races the watcher', since: '2026-09-30' } } };

  it('turns a quarantined FAIL or TIMEOUT into QUARANTINED-FAIL, which does not fail the run', () => {
    expect(applyQuarantine('flaky', 'FAIL', q)).toBe('QUARANTINED-FAIL');
    expect(applyQuarantine('flaky', 'TIMEOUT', q)).toBe('QUARANTINED-FAIL');
    expect(isGreen('QUARANTINED-FAIL')).toBe(true);
  });

  it('leaves passes, flakes and scenarios that are not quarantined alone', () => {
    expect(applyQuarantine('flaky', 'PASS', q)).toBe('PASS');
    expect(applyQuarantine('flaky', 'FLAKY', q)).toBe('FLAKY');
    expect(applyQuarantine('other', 'FAIL', q)).toBe('FAIL');
    expect(applyQuarantine('flaky', 'FAIL', null)).toBe('FAIL');
  });
});

describe('the e2e lock wait is off the scenario clock', () => {
  it('the harness watchdog counts from process start minus the lock wait', () => {
    expect(watchdogDelayMs({ deadlineMs: 200_000, uptimeMs: 5_000, lockWaitMs: 0 })).toBe(195_000);
    // Waited 150 s for another checkout's app: the scenario still gets its full budget.
    expect(watchdogDelayMs({ deadlineMs: 200_000, uptimeMs: 155_000, lockWaitMs: 150_000 })).toBe(
      195_000,
    );
    expect(watchdogDelayMs({ deadlineMs: 200_000, uptimeMs: 250_000, lockWaitMs: 0 })).toBe(0);
  });

  it('the runner reads the wait from the harness line that extends its kill timer', () => {
    expect(lockWaitMsFromLine('[e2e-lock] acquired after 42s')).toBe(42_000);
    expect(lockWaitMsFromLine('[e2e-lock] waiting for pid 7 (cwd, G:/x)')).toBeNull();
    expect(lockWaitMsFromLine('[scenario] acquired after 3s')).toBeNull();
  });
});

describe('the runner kill timer', () => {
  const KILL = 210_000;
  const s0 = killTimerStart(1_000, { killMs: KILL });
  const waiting = '[e2e-lock] waiting for pid 7 (split-editor, G:/x)';

  it('a scenario that never waits is killed KILL_MS after its start', () => {
    expect(s0).toMatchObject({ deadline: 1_000 + KILL, reason: 'run' });
    expect(killTimerOnLine(s0, '[e2e-lock] something else', 5_000)).toBe(s0);
  });

  it('the first waiting line suspends the scenario clock; only the wait cap can fire', () => {
    const w = killTimerOnLine(s0, waiting, 3_000);
    expect(w).toMatchObject({ reason: 'lock-wait', deadline: 3_000 + KILL_TIMER_LOCK_CAP_MS });
    // The report repeats every 30 s while waiting; it must not re-arm anything.
    const later = killTimerOnLine(w, waiting, 400_000);
    expect(later).toEqual(w);
    expect(later.deadline).toBeGreaterThan(1_000 + KILL + 400_000);
  });

  it('acquiring re-arms the kill at start + KILL_MS + the wait the harness reports', () => {
    const w = killTimerOnLine(s0, waiting, 3_000);
    const a = killTimerOnLine(w, '[e2e-lock] acquired after 400s', 403_000);
    expect(a).toMatchObject({ reason: 'run', deadline: 1_000 + KILL + 400_000 });
  });

  it('the wait cap is 20 minutes unless overridden', () => {
    expect(KILL_TIMER_LOCK_CAP_MS).toBe(20 * 60_000);
    const w = killTimerOnLine(killTimerStart(0, { killMs: KILL, waitCapMs: 50 }), waiting, 10);
    expect(w).toMatchObject({ reason: 'lock-wait', deadline: 60 });
  });
});

describe('orphanVictims: the sweep only touches Electrons of this run', () => {
  const proc = (ProcessId: number, ParentProcessId: number, CommandLine: string) => ({
    ProcessId,
    ParentProcessId,
    CommandLine,
  });
  // Quoted as measured on Windows: Playwright quotes each whole argument of the app it launches,
  // Chromium quotes only the value in the switches it passes its children.
  const dir = (n: string) => String.raw`C:\Users\Jo Doe\AppData\Local\Temp\conduit-ud-` + n;
  const exe = String.raw`"G:\repo\node_modules\electron\dist\electron.exe"`;
  const root = (n: string, run: string) =>
    `${exe}  "--inspect=0" "--user-data-dir=${dir(n)}" "G:\\repo" "${RUN_MARKER}=${run}"`;
  const child = (type: string, n: string) => `${exe} --type=${type} --user-data-dir="${dir(n)}"`;
  const procs = [
    // This run's app: marked root, a child, and a GPU process whose parent already died.
    proc(10, 1, root('mine', 'run-A')),
    proc(11, 10, child('renderer', 'mine')),
    proc(12, 999, child('gpu-process', 'mine')),
    // Another worktree's run holding the e2e lock: same temp dir, different run.
    proc(20, 1, root('theirs', 'run-B')),
    proc(21, 20, child('renderer', 'theirs')),
    // Prefixes of this run's profile dir and run id are someone else's.
    proc(22, 1, root('mine2', 'run-D')),
    proc(23, 1, root('other', 'run-A-2')),
    // The developer's own Conduit.
    proc(30, 1, String.raw`"C:\Program Files\Conduit\Conduit.exe" G:\awby\projects\conduit`),
  ];

  it("kills this run's tree and nothing else", () => {
    expect(orphanVictims(procs, 'run-A')).toEqual([10, 11, 12]);
  });

  it('a child whose root already died is found by its run-scoped profile dir', () => {
    const scoped = (run: string, label: string) =>
      `C:\\Users\\Jo Doe\\AppData\\Local\\Temp\\${profilePrefix(run)}${label}`;
    const orphans = [
      proc(40, 999, `${exe} --type=renderer --user-data-dir="${scoped('9-aaaa0001', 'x1')}"`),
      proc(41, 40, `${exe} --type=utility`),
      proc(42, 999, `${exe} --type=gpu-process --user-data-dir="${scoped('9-aaaa0002', 'x1')}"`),
      proc(43, 999, `${exe} --type=gpu-process --user-data-dir="${dir('9-aaaa0001x')}"`),
    ];
    expect(profilePrefix('9-aaaa0001')).toBe('conduit-ud-9-aaaa0001-');
    expect(orphanVictims(orphans, '9-aaaa0001')).toEqual([40, 41]);
  });

  it('a run with nothing left finds nothing', () => {
    expect(orphanVictims(procs, 'run-C')).toEqual([]);
    expect(orphanVictims([], 'run-A')).toEqual([]);
  });
});
