import { describe, expect, it } from 'vitest';
import {
  BUSY_RESUME_MS,
  createLimitMonitor,
  FIRE_DEFER_MAX_MS,
  FIRE_QUIET_MS,
  ISSUE_AUTO_RESUME_OFF,
  ISSUE_RESET_UNKNOWN,
  type LimitMonitorDeps,
  RULE_SCAN_INTERVAL_MS,
} from '../../server/domain/limit-monitor';
import type { CliKind } from '../../src/conduit-mcp/tool-policy';
import type { LimitRule, RuleMatch } from '../../src/contracts/auto-resume';
import type { Job, JobState } from '../../src/contracts/scheduler';
import type { ArmResumeInput } from '../../src/scheduler';

const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
const HOUR = 3_600_000;

function harness(over: Partial<LimitMonitorDeps> = {}) {
  let now = T0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const jobs: Job[] = [];
  const armed: ArmResumeInput[] = [];
  const verifies: { sessionId: string; outcome: unknown }[] = [];
  const rechecks: string[] = [];
  const issues = new Map<string, string | null>();
  const busyNow = new Map<string, boolean>();
  const settings = {
    autoResume: 'on' as 'on' | 'ask' | 'off',
    autoResumeMarginMs: 120_000,
    autoResumeMaxAttempts: 3,
    autoResumeMessage: 'Continue',
  };
  const modes = new Map<string, 'on' | 'off'>();
  let screenRows: readonly string[] = [];
  let ruleMatch: RuleMatch | null = null;
  const setState = (id: string, state: JobState) => {
    const j = jobs.find((x) => x.id === id);
    if (j) j.state = state;
  };
  const deps: LimitMonitorDeps = {
    now: () => now,
    setTimer: (ms, fn) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    scheduler: {
      list: () => jobs,
      armResume: (input) => {
        armed.push(input);
        const live = jobs.find(
          (j) =>
            j.sessionId === input.sessionId &&
            j.trigger.kind === 'limit-reset' &&
            !['done', 'skipped', 'failed', 'cancelled'].includes(j.state),
        );
        const trigger = {
          kind: 'limit-reset' as const,
          episodeId: input.episodeId,
          resetAt: input.resetAt,
          marginMs: input.marginMs,
        };
        if (live) {
          live.trigger = trigger;
          live.nextAt = input.resetAt + input.marginMs;
          return { ok: true, job: live };
        }
        const job: Job = {
          id: `job-${jobs.length + 1}`,
          sessionId: input.sessionId,
          origin: 'limit',
          trigger,
          action: { kind: 'send', message: input.message },
          nextAt: input.resetAt + input.marginMs,
          state: input.proposed ? 'proposed' : 'armed',
          attempts: 0,
          maxAttempts: input.maxAttempts,
          createdAt: now,
          history: [],
        };
        jobs.push(job);
        return { ok: true, job };
      },
      accept: (id) => {
        setState(id, 'armed');
        return true;
      },
      cancel: (id) => {
        setState(id, 'cancelled');
        return true;
      },
      resolveVerify: (sessionId, outcome) => {
        verifies.push({ sessionId, outcome });
      },
      recheck: (jobId) => {
        rechecks.push(jobId);
      },
    },
    settings: () => settings,
    sessionMode: (id) => modes.get(id),
    cliOf: () => 'claude' as CliKind,
    isBusy: (id) => busyNow.get(id) ?? false,
    screen: async () => screenRows,
    scanRules: () => ruleMatch,
    setResumeIssue: (id, reason) => {
      issues.set(id, reason);
    },
    onChange: () => {},
    log: { info: () => {}, warn: () => {} },
    ...over,
  };
  const monitor = createLimitMonitor(deps);
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      now = t.at;
      t.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = until;
  };
  return {
    monitor,
    jobs,
    armed,
    verifies,
    rechecks,
    issues,
    busyNow,
    settings,
    modes,
    advance,
    setNow: (t: number) => {
      now = t;
    },
    setScreen: (rows: readonly string[], match: RuleMatch | null) => {
      screenRows = rows;
      ruleMatch = match;
    },
  };
}

const rule = (over: Partial<LimitRule> = {}): LimitRule => ({
  id: 'default:claude:resets',
  cli: 'claude',
  enabled: true,
  match: 'x',
  kind: 'usage-limit',
  reset: { group: 'reset', format: 'clock-or-date' },
  ...over,
});
const match = (resetAt: number | null, over: Partial<LimitRule> = {}): RuleMatch => ({
  rule: rule(over),
  resetAt,
  resetText: resetAt === null ? null : '3pm',
  reason: 'Claude usage limit reached',
});

describe('limit monitor — arming (spec §7 EARS 1, R8)', () => {
  it('arms exactly one resume job at resetAt + margin for a structured limit', () => {
    const h = harness();
    const resetAt = T0 + HOUR;
    h.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, resetAt, source: 'claude-hook' });
    h.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, resetAt, source: 'claude-hook' });
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]?.nextAt).toBe(resetAt + 120_000);
    expect(h.monitor.episodes()).toHaveLength(1);
  });

  it('takes the reset time from the newest reset-info: the full window, the later of two', () => {
    const h = harness();
    h.monitor.signal({
      kind: 'reset-info',
      sessionId: 's',
      at: T0,
      source: 'claude-statusline',
      windows: [
        { name: 'five_hour', usedPct: 100, resetAt: T0 + HOUR },
        { name: 'seven_day', usedPct: 100, resetAt: T0 + 3 * HOUR },
        { name: 'other', usedPct: 10, resetAt: T0 + HOUR / 2 },
      ],
    });
    h.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, source: 'claude-hook' });
    expect(h.armed[0]?.resetAt).toBe(T0 + 3 * HOUR);
  });

  it('without a reset time arms nothing and marks needs-you; a later reset-info arms', () => {
    const h = harness();
    h.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, source: 'claude-hook' });
    expect(h.jobs).toHaveLength(0);
    expect(h.issues.get('s')).toBe(ISSUE_RESET_UNKNOWN);
    h.monitor.signal({
      kind: 'reset-info',
      sessionId: 's',
      at: T0,
      source: 'claude-statusline',
      windows: [{ name: 'five_hour', usedPct: 100, resetAt: T0 + HOUR }],
    });
    expect(h.jobs).toHaveLength(1);
    expect(h.issues.get('s')).toBeNull();
  });

  it('treats a reset in the past or more than 8 days out as unknown', () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 - 1,
      source: 'claude-hook',
    });
    h.monitor.signal({
      kind: 'limited',
      sessionId: 't',
      at: T0,
      resetAt: T0 + 9 * 24 * HOUR,
      source: 'claude-hook',
    });
    expect(h.jobs).toHaveLength(0);
    expect(h.issues.get('s')).toBe(ISSUE_RESET_UNKNOWN);
    expect(h.issues.get('t')).toBe(ISSUE_RESET_UNKNOWN);
  });

  it('off (global or per session) tracks the episode but arms nothing', () => {
    const h = harness();
    h.settings.autoResume = 'off';
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    expect(h.jobs).toHaveLength(0);
    expect(h.monitor.episodes()[0]?.state).toBe('open');
    expect(h.issues.get('s')).toBe(ISSUE_AUTO_RESUME_OFF);
    h.settings.autoResume = 'on';
    h.modes.set('t', 'off');
    h.monitor.signal({
      kind: 'limited',
      sessionId: 't',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    expect(h.jobs).toHaveLength(0);
  });

  it('a per-session on wins over a global off', () => {
    const h = harness();
    h.settings.autoResume = 'off';
    h.modes.set('s', 'on');
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    expect(h.jobs[0]?.state).toBe('armed');
  });

  it('ask proposes and offers; accept arms; dismiss cancels and suppresses for 30 min', () => {
    const h = harness();
    h.settings.autoResume = 'ask';
    const resetAt = T0 + HOUR;
    h.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, resetAt, source: 'claude-hook' });
    expect(h.jobs[0]?.state).toBe('proposed');
    expect(h.monitor.offer()).toMatchObject({ sessionId: 's', resetAt });
    expect(h.monitor.answerOffer('s', 'arm')).toBe(true);
    expect(h.jobs[0]?.state).toBe('armed');
    expect(h.monitor.offer()).toBeNull();

    const g = harness();
    g.settings.autoResume = 'ask';
    g.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, resetAt, source: 'claude-hook' });
    g.monitor.answerOffer('s', 'dismiss');
    expect(g.jobs[0]?.state).toBe('cancelled');
    g.monitor.signal({
      kind: 'resumed',
      sessionId: 's',
      at: T0,
      by: 'turn',
      source: 'claude-hook',
    });
    g.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, resetAt, source: 'claude-hook' });
    expect(g.jobs).toHaveLength(1);
    g.setNow(T0 + 31 * 60_000);
    g.monitor.signal({
      kind: 'resumed',
      sessionId: 's',
      at: T0,
      by: 'turn',
      source: 'claude-hook',
    });
    g.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, resetAt, source: 'claude-hook' });
    expect(g.jobs).toHaveLength(2);
  });
});

describe('limit monitor — pre-fire (R4, §7 EARS 2)', () => {
  const armedJob = () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    return { h, job: h.jobs[0] as Job };
  };

  it('goes when the episode is open and the session idle', () => {
    const { h, job } = armedJob();
    expect(h.monitor.preFire(job)).toEqual({ go: true });
  });

  it('skips "already resumed" after the CLI resumed by itself', () => {
    const { h, job } = armedJob();
    h.monitor.signal({
      kind: 'resumed',
      sessionId: 's',
      at: T0,
      by: 'cli-auto',
      source: 'claude-hook',
    });
    expect(h.monitor.preFire(job)).toEqual({ go: false, reason: 'already resumed' });
  });

  it('skips after human input through the window path', () => {
    const { h, job } = armedJob();
    h.monitor.onHumanInput('s');
    expect(h.monitor.preFire(job)).toEqual({ go: false, reason: 'already resumed' });
  });

  it('R13: busy at fire time defers; after 3 s of quiet the recheck delivers', async () => {
    const { h, job } = armedJob();
    h.busyNow.set('s', true);
    expect(h.monitor.preFire(job)).toEqual({ go: 'wait', reason: 'session busy' });
    await h.advance(FIRE_QUIET_MS - 1);
    h.monitor.onData('s');
    await h.advance(FIRE_QUIET_MS - 1);
    expect(h.rechecks).toEqual([]);
    h.busyNow.set('s', false);
    await h.advance(1);
    expect(h.rechecks).toEqual([job.id]);
    expect(h.monitor.preFire(job)).toEqual({ go: true });
  });

  it('R13: two minutes of continuous output skips "session kept working" and resolves the episode', async () => {
    const { h, job } = armedJob();
    h.busyNow.set('s', true);
    expect(h.monitor.preFire(job)).toMatchObject({ go: 'wait' });
    for (let t = 0; t < FIRE_DEFER_MAX_MS; t += 1_000) {
      h.monitor.onData('s');
      await h.advance(1_000);
    }
    expect(h.rechecks).toEqual([job.id]);
    expect(h.monitor.preFire(job)).toEqual({ go: false, reason: 'session kept working' });
    expect(h.monitor.episodes()[0]?.state).toBe('resumed');
  });

  it('R13: a repaint burst after the episode opens never skips a Claude job', async () => {
    const { h, job } = armedJob();
    h.monitor.onAdapterLive('s');
    h.monitor.onBusy('s', true);
    await h.advance(BUSY_RESUME_MS * 3);
    h.monitor.onBusy('s', false);
    expect(h.monitor.preFire(job)).toEqual({ go: true });
  });

  it('R13: a rules-only session resumes only when busy holds BUSY_RESUME_MS', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'rule:x',
    });
    const job = h.jobs[0] as Job;
    h.monitor.onBusy('s', true);
    await h.advance(BUSY_RESUME_MS / 2);
    h.monitor.onBusy('s', false);
    await h.advance(BUSY_RESUME_MS);
    expect(h.monitor.preFire(job)).toEqual({ go: true });
    h.monitor.onBusy('s', true);
    await h.advance(BUSY_RESUME_MS);
    expect(h.monitor.preFire(job)).toEqual({ go: false, reason: 'already resumed' });
  });
});

describe('limit monitor — verify mapping (§2 step 5)', () => {
  const verifying = () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    (h.jobs[0] as Job).state = 'verifying';
    return h;
  };

  it('a resumed signal resolves the verifying job as resumed', () => {
    const h = verifying();
    h.monitor.signal({
      kind: 'resumed',
      sessionId: 's',
      at: T0,
      by: 'turn',
      source: 'claude-hook',
    });
    expect(h.verifies).toEqual([{ sessionId: 's', outcome: { kind: 'resumed' } }]);
    expect(h.monitor.episodes()[0]?.state).toBe('resumed');
  });

  it('a structured limited re-arms at the later reset', () => {
    const h = verifying();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + 2 * HOUR,
      source: 'claude-hook',
    });
    expect(h.verifies).toEqual([
      { sessionId: 's', outcome: { kind: 'limited', resetAt: T0 + 2 * HOUR } },
    ]);
  });

  it("a rule's lingering notice with the same reset does not count as limited again", () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'rule:x',
    });
    (h.jobs[0] as Job).state = 'verifying';
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'rule:x',
    });
    expect(h.verifies).toEqual([]);
  });

  it('a failed job raises needs-you with the reason', () => {
    const h = verifying();
    h.monitor.onJobFailed(h.jobs[0] as Job, 'still limited');
    expect(h.issues.get('s')).toBe('Auto-resume failed: still limited');
  });
});

describe('limit monitor — lifecycle (R1)', () => {
  const open = () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    return h;
  };

  it('a PTY loss other than the agent exiting keeps the episode open', () => {
    const h = open();
    h.monitor.onPtyExit('s', 'killed');
    expect(h.monitor.episodes()[0]?.state).toBe('open');
  });

  it('the agent quitting on its own closes it and cancels the job', () => {
    const h = open();
    h.monitor.onPtyExit('s', 'exited');
    expect(h.monitor.episodes()[0]?.state).toBe('closed');
    expect(h.jobs[0]?.state).toBe('cancelled');
  });

  it('closing the session drops the episode', () => {
    const h = open();
    h.monitor.onSessionClosed('s');
    expect(h.monitor.episodes()).toHaveLength(0);
  });

  it('expires 24 h after the reset', async () => {
    const h = open();
    await h.advance(HOUR + 24 * HOUR + 11 * 60_000);
    expect(h.monitor.episodes()[0]?.state).toBe('expired');
  });

  it('restores persisted episodes so pre-fire stays meaningful after a restart', () => {
    const h = open();
    const saved = h.monitor.episodes();
    const g = harness();
    g.monitor.load(saved);
    const job = { ...(h.jobs[0] as Job) };
    expect(g.monitor.preFire(job)).toEqual({ go: true });
  });
});

describe('limit monitor — rules scan (R6, R3)', () => {
  it('scans at most once per second, trailing edge, and opens an episode from a rule', async () => {
    let reads = 0;
    const h = harness({
      cliOf: () => 'cursor',
      screen: async () => {
        reads++;
        return ['row'];
      },
    });
    h.setScreen(['row'], match(T0 + HOUR));
    h.monitor.onData('s');
    await h.advance(0);
    for (let i = 0; i < 10; i++) {
      h.monitor.onData('s');
      await h.advance(50);
    }
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(reads).toBe(2);
    expect(h.jobs).toHaveLength(1);
    expect(h.monitor.episodes()[0]?.source).toBe('rule:default:claude:resets');
  });

  it('a rule-only episode resumes after two scans without the match', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], match(T0 + HOUR));
    h.monitor.onData('s');
    await h.advance(0);
    h.setScreen(['work'], null);
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.monitor.episodes()[0]?.state).toBe('open');
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.monitor.episodes()[0]?.state).toBe('resumed');
  });

  it('the same notice still on screen does not reopen a resolved episode', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], match(T0 + HOUR));
    h.monitor.onData('s');
    await h.advance(0);
    h.monitor.onHumanInput('s');
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.monitor.episodes()[0]?.state).toBe('resumed');
    expect(h.jobs).toHaveLength(1);
  });

  it('a structured session ignores rule-opened episodes but takes a missing reset time', async () => {
    const h = harness();
    h.monitor.signal({ kind: 'limited', sessionId: 's', at: T0, source: 'claude-hook' });
    expect(h.jobs).toHaveLength(0);
    h.setScreen(['limit'], match(T0 + HOUR));
    h.monitor.onData('s');
    await h.advance(0);
    expect(h.jobs).toHaveLength(1);
    expect(h.monitor.episodes()[0]?.source).toBe('claude-hook');
  });

  it('a structured limit after a rule-opened episode upgrades it, no duplicate (late Codex bind)', async () => {
    const h = harness({ cliOf: () => 'codex' });
    h.setScreen(['limit'], match(T0 + HOUR, { id: 'default:codex:try-again', cli: 'codex' }));
    h.monitor.onData('s');
    await h.advance(0);
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'codex-rollout',
    });
    expect(h.monitor.episodes()).toHaveLength(1);
    expect(h.monitor.episodes()[0]?.source).toBe('codex-rollout');
    expect(h.jobs).toHaveLength(1);
  });

  it('a prompt-kind rule (not a limit) opens nothing', async () => {
    const h = harness({ cliOf: () => 'codex' });
    h.setScreen(
      ['prompt'],
      match(null, { kind: 'rate-limit-prompt', reset: undefined, id: 'default:codex:switch' }),
    );
    h.monitor.onData('s');
    await h.advance(0);
    expect(h.monitor.episodes()).toHaveLength(0);
  });

  it('never scans a shell', async () => {
    let reads = 0;
    const h = harness({
      cliOf: () => null,
      screen: async () => {
        reads++;
        return [];
      },
    });
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS * 2);
    expect(reads).toBe(0);
  });
});

const textMatch = (resetAt: number | null, resetText: string, over: Partial<LimitRule> = {}) => ({
  ...match(resetAt, over),
  resetText,
});

describe('limit monitor — review fixes on d30afb9f', () => {
  it('B1: after a restart a restored structured episode ignores a repaint busy edge', async () => {
    const h = harness();
    h.monitor.load([
      {
        id: 'ep-1',
        sessionId: 's',
        cli: 'claude',
        startedAt: T0,
        resetAt: T0 + HOUR,
        source: 'claude-hook',
        state: 'open',
      },
    ]);
    h.monitor.onBusy('s', true);
    await h.advance(BUSY_RESUME_MS * 2);
    expect(h.monitor.episodes()[0]?.state).toBe('open');
  });

  it('B1: a session whose adapter is live ignores rule-opened episodes before its first signal', async () => {
    const h = harness({ cliOf: () => 'claude' });
    h.monitor.onAdapterLive('s');
    h.setScreen(['limit'], match(T0 + HOUR));
    h.monitor.onData('s');
    await h.advance(0);
    expect(h.monitor.episodes()).toHaveLength(0);
  });

  it('B1: a restored episode with no reset time raises its needs-you again', () => {
    const h = harness();
    h.monitor.load([
      {
        id: 'ep-1',
        sessionId: 's',
        cli: 'codex',
        startedAt: T0,
        resetAt: null,
        source: 'codex-rollout',
        state: 'open',
      },
    ]);
    expect(h.issues.get('s')).toBe(ISSUE_RESET_UNKNOWN);
  });

  it('B2: a busy edge from before the episode opened does not close it', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.monitor.onBusy('s', true);
    await h.advance(1_000);
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'rule:x',
    });
    await h.advance(BUSY_RESUME_MS * 2);
    expect(h.monitor.episodes()[0]?.state).toBe('open');
  });

  it('B3: a structured limit upgrades the rule-opened episode in place (same id, one arm)', async () => {
    const h = harness({ cliOf: () => 'codex' });
    h.setScreen(['limit'], match(T0 + HOUR, { id: 'default:codex:try-again', cli: 'codex' }));
    h.monitor.onData('s');
    await h.advance(0);
    const id = h.monitor.episodes()[0]?.id;
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'codex-rollout',
    });
    expect(h.monitor.episodes()[0]?.id).toBe(id);
    expect(h.monitor.episodes()[0]?.state).toBe('open');
    expect(h.armed).toHaveLength(1);
  });

  it('B4: the same notice read after its clock rolled to tomorrow is not "limited again"', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    const job = h.jobs[0] as Job;
    expect(h.monitor.preFire(job)).toEqual({ go: true });
    job.state = 'verifying';
    h.setScreen(['limit'], textMatch(T0 + 25 * HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.verifies).toEqual([]);
  });

  it('B4: a notice that went away after the send and came back is "limited again"', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    const job = h.jobs[0] as Job;
    h.monitor.preFire(job);
    job.state = 'verifying';
    h.setScreen(['working'], null);
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    h.setScreen(['limit'], textMatch(T0 + 2 * HOUR, '5:45 PM'));
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.verifies).toEqual([
      { sessionId: 's', outcome: { kind: 'limited', resetAt: T0 + 2 * HOUR } },
    ]);
  });

  it('B4: a resolved notice still on screen does not reopen even when its parse rolled over', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    h.monitor.onHumanInput('s');
    h.setScreen(['limit'], textMatch(T0 + 25 * HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.monitor.episodes()[0]?.state).toBe('resumed');
    expect(h.armed).toHaveLength(1);
  });

  it('S1: a re-arm drops the busy deferral, so the next fire is checked afresh', async () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    const job = h.jobs[0] as Job;
    h.busyNow.set('s', true);
    expect(h.monitor.preFire(job)).toMatchObject({ go: 'wait' });
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + 2 * HOUR,
      source: 'claude-hook',
    });
    await h.advance(FIRE_DEFER_MAX_MS + 1);
    h.busyNow.set('s', false);
    expect(h.monitor.preFire(job)).toEqual({ go: true });
  });

  it('S1: a PTY exit drops the busy deferral', async () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    const job = h.jobs[0] as Job;
    h.busyNow.set('s', true);
    h.monitor.preFire(job);
    h.monitor.onPtyExit('s', 'killed');
    await h.advance(FIRE_DEFER_MAX_MS + 1);
    h.busyNow.set('s', false);
    expect(h.monitor.preFire(job)).toEqual({ go: true });
  });

  it('S3: a resume seen while the job is sending is applied once it reaches verifying', async () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    const job = h.jobs[0] as Job;
    job.state = 'sending';
    h.monitor.signal({
      kind: 'resumed',
      sessionId: 's',
      at: T0,
      by: 'turn',
      source: 'claude-hook',
    });
    expect(h.verifies).toEqual([]);
    job.state = 'verifying';
    await h.advance(1_000);
    expect(h.verifies).toEqual([{ sessionId: 's', outcome: { kind: 'resumed' } }]);
  });

  it('S4: a scan that finishes after the session closed does not reopen an episode', async () => {
    let release: (rows: readonly string[]) => void = () => {};
    const h = harness({
      cliOf: () => 'cursor',
      screen: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    h.setScreen(['limit'], match(T0 + HOUR));
    h.monitor.onData('s');
    await h.advance(0);
    h.monitor.onSessionClosed('s');
    release(['limit']);
    await h.advance(0);
    expect(h.monitor.episodes()).toHaveLength(0);
  });

  it('turning auto-resume off cancels the armed job and pre-fire refuses; on arms again', () => {
    const h = harness();
    h.monitor.signal({
      kind: 'limited',
      sessionId: 's',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    const job = h.jobs[0] as Job;
    h.modes.set('s', 'off');
    expect(h.monitor.preFire(job)).toEqual({ go: false, reason: 'auto-resume is off' });
    h.monitor.onModeChanged();
    expect(job.state).toBe('cancelled');
    expect(h.issues.get('s')).toBe(ISSUE_AUTO_RESUME_OFF);
    h.modes.set('s', 'on');
    h.monitor.onModeChanged();
    expect(h.jobs.filter((j) => j.state === 'armed')).toHaveLength(1);
  });

  it('two ask-mode sessions: answering the first offer shows the second', () => {
    const h = harness();
    h.settings.autoResume = 'ask';
    h.monitor.signal({
      kind: 'limited',
      sessionId: 'a',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    h.monitor.signal({
      kind: 'limited',
      sessionId: 'b',
      at: T0,
      resetAt: T0 + HOUR,
      source: 'claude-hook',
    });
    expect(h.monitor.offer()?.sessionId).toBe('a');
    h.monitor.answerOffer('a', 'arm');
    expect(h.monitor.offer()?.sessionId).toBe('b');
  });
});

describe('limit monitor — review round 2', () => {
  it('B1: the same notice re-read after its clock rolled over does not move an armed job', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    h.setScreen(['limit'], textMatch(T0 + 25 * HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.armed).toHaveLength(1);
    expect(h.jobs[0]?.nextAt).toBe(T0 + HOUR + 120_000);
    (h.jobs[0] as Job).state = 'waiting';
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.armed).toHaveLength(1);
  });

  it('B2: a notice that left the screen and came back with the same text opens a new episode', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    h.monitor.onHumanInput('s');
    h.setScreen(['working'], null);
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    h.setScreen(['limit'], textMatch(T0 + 2 * HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.monitor.episodes()[0]?.state).toBe('open');
    expect(h.armed).toHaveLength(2);
  });

  it('B3: a restored Codex episode is rules-only until a launch binds its file again', async () => {
    const h = harness({ cliOf: () => 'codex' });
    h.monitor.load([
      {
        id: 'ep-1',
        sessionId: 's',
        cli: 'codex',
        startedAt: T0,
        resetAt: T0 + HOUR,
        source: 'codex-rollout',
        state: 'open',
      },
    ]);
    h.monitor.onBusy('s', true);
    await h.advance(BUSY_RESUME_MS);
    expect(h.monitor.episodes()[0]?.state).toBe('resumed');
  });
});

describe('limit monitor — review round 3', () => {
  it('a restored rule episode keeps its notice key: the rolled-over re-read does not move the job', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.monitor.load([
      {
        id: 'ep-1',
        sessionId: 's',
        cli: 'cursor',
        startedAt: T0,
        resetAt: T0 + HOUR,
        source: 'rule:default:claude:resets',
        state: 'open',
        ruleKey: 'default:claude:resets@3:45 PM',
      },
    ]);
    h.setScreen(['limit'], textMatch(T0 + 25 * HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    expect(h.armed).toHaveLength(0);
    expect(h.monitor.episodes()[0]?.resetAt).toBe(T0 + HOUR);
  });

  it('records the notice key on the episode so it is persisted', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    expect(h.monitor.episodes()[0]?.ruleKey).toBe('default:claude:resets@3:45 PM');
  });

  it('one scan landing mid-redraw does not clear the resolved notice', async () => {
    const h = harness({ cliOf: () => 'cursor' });
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(0);
    h.monitor.onHumanInput('s');
    h.setScreen([''], null);
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    h.setScreen(['limit'], textMatch(T0 + HOUR, '3:45 PM'));
    h.monitor.onData('s');
    await h.advance(RULE_SCAN_INTERVAL_MS);
    expect(h.monitor.episodes()[0]?.state).toBe('resumed');
    expect(h.armed).toHaveLength(1);
  });
});
