import { describe, expect, it } from 'vitest';
import type { Job, LimitEpisode, SchedulerFile } from '../../src/contracts/scheduler';
import { JOB_HISTORY_MAX } from '../../src/contracts/scheduler';
import {
  migrateTimedMessagesV1,
  parseSchedulerFile,
  serializeSchedulerFile,
} from '../../src/scheduler-store';
import type { TimedMessage, TimedMessagesFile } from '../../src/timed-messages';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const OPTS = { maxAttempts: 3 };
const HOUR = 3_600_000;

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    sessionId: 's1',
    origin: 'user',
    trigger: { kind: 'in', delayMs: 60_000 },
    action: { kind: 'send', message: 'Continue' },
    nextAt: NOW + 60_000,
    state: 'armed',
    attempts: 0,
    maxAttempts: 3,
    createdAt: NOW,
    history: [],
    firedCount: 0,
    ...over,
  };
}

function limitJob(over: Partial<Job> = {}): Job {
  return job({
    id: 'L1',
    origin: 'limit',
    trigger: { kind: 'limit-reset', episodeId: 'e1', resetAt: NOW + HOUR, marginMs: 60_000 },
    nextAt: NOW + HOUR + 60_000,
    firedCount: undefined,
    ...over,
  });
}

function episode(over: Partial<LimitEpisode> = {}): LimitEpisode {
  return {
    id: 'e1',
    sessionId: 's1',
    cli: 'claude',
    startedAt: NOW,
    resetAt: NOW + HOUR,
    source: 'claude-hook',
    state: 'open',
    ...over,
  };
}

function v2(over: Partial<SchedulerFile> = {}): string {
  return JSON.stringify({ version: 2, jobs: [], episodes: [], ...over });
}

function v1Schedule(over: Partial<TimedMessage> = {}): TimedMessage {
  return {
    id: 'tm-1',
    sessionId: 's1',
    message: 'Continue',
    kind: 'once',
    nextAt: NOW + 60_000,
    maxRepeats: 1,
    firedCount: 0,
    state: 'armed',
    origin: 'manual',
    createdAt: NOW,
    ...over,
  };
}

function v1File(schedules: TimedMessage[]): TimedMessagesFile {
  return { version: 1, schedules };
}

describe('parseSchedulerFile', () => {
  it('parses null/corrupt/foreign as empty', () => {
    const empty = { version: 2, jobs: [], episodes: [] };
    expect(parseSchedulerFile(null, OPTS)).toEqual(empty);
    expect(parseSchedulerFile('{not json', OPTS)).toEqual(empty);
    expect(parseSchedulerFile('[1,2]', OPTS)).toEqual(empty);
    expect(parseSchedulerFile(JSON.stringify({ version: 2, jobs: 'x' }), OPTS)).toEqual(empty);
    expect(parseSchedulerFile(JSON.stringify({ version: 1, jobs: [] }), OPTS)).toEqual(empty);
    expect(parseSchedulerFile(JSON.stringify({ jobs: [] }), OPTS)).toEqual(empty);
  });

  it('marks a newer file', () => {
    const blob = JSON.stringify({ version: 3, jobs: [job()], episodes: [] });
    expect(parseSchedulerFile(blob, OPTS)).toEqual({
      version: 2,
      jobs: [],
      episodes: [],
      kind: 'newer',
    });
  });

  it('round-trips a v2 file', () => {
    const original: SchedulerFile = {
      version: 2,
      jobs: [job(), limitJob()],
      episodes: [episode()],
    };
    const parsed = parseSchedulerFile(serializeSchedulerFile(original, NOW), OPTS);
    expect(parsed).toEqual(original);
  });

  it('drops invalid jobs: empty message, unknown trigger kind, Infinity interval', () => {
    const jobs: unknown[] = [
      job({ id: 'empty', action: { kind: 'send', message: '   ' } }),
      { ...job({ id: 'unknown' }), trigger: { kind: 'weekly', delayMs: 1 } },
      { ...job({ id: 'inf' }), trigger: { kind: 'every', everyMs: 0, maxRepeats: 2 } },
      job({ id: 'ok' }),
    ];
    // JSON.stringify turns Infinity into null; the file on disk carries the literal 1e999,
    // which JSON.parse reads back as Infinity.
    const blob = JSON.stringify({ version: 2, jobs, episodes: [] }).replace(
      '"everyMs":0',
      '"everyMs":1e999',
    );
    const ids = parseSchedulerFile(blob, OPTS).jobs.map((j) => j.id);
    expect(ids).toEqual(['ok']);
  });

  it('keeps line breaks in a stored message', () => {
    const blob = v2({ jobs: [job({ action: { kind: 'send', message: 'one\ntwo' } })] });
    expect(parseSchedulerFile(blob, OPTS).jobs[0].action.message).toBe('one\ntwo');
  });
});

describe('migrateTimedMessagesV1 (R9)', () => {
  it('R9: once with spec → at trigger', () => {
    const { jobs } = migrateTimedMessagesV1(
      v1File([v1Schedule({ spec: { clock: '15:30', zone: 'America/Toronto' } })]),
      { maxAttempts: 3 },
    );
    expect(jobs[0].trigger).toEqual({ kind: 'at', clock: '15:30', zone: 'America/Toronto' });
  });

  it('R9: once without spec → in trigger delayMs = nextAt − createdAt', () => {
    const { jobs } = migrateTimedMessagesV1(v1File([v1Schedule()]), { maxAttempts: 3 });
    expect(jobs[0].trigger).toEqual({ kind: 'in', delayMs: 60_000 });
  });

  it('R9: interval → every', () => {
    const { jobs } = migrateTimedMessagesV1(
      v1File([
        v1Schedule({ kind: 'interval', everyMs: 300_000, maxRepeats: 4, nextAt: NOW + 300_000 }),
      ]),
      { maxAttempts: 3 },
    );
    expect(jobs[0].trigger).toEqual({ kind: 'every', everyMs: 300_000, maxRepeats: 4 });
  });

  it('R9: firedCount, waitingSince copied; lastFire → one history entry', () => {
    const { jobs } = migrateTimedMessagesV1(
      v1File([
        v1Schedule({
          kind: 'interval',
          everyMs: 300_000,
          maxRepeats: 4,
          firedCount: 2,
          state: 'waiting',
          waitingSince: NOW + 1000,
          lastFire: { at: NOW + 500, late: true, delivered: false, reason: 'noSession' },
        }),
      ]),
      { maxAttempts: 3 },
    );
    expect(jobs[0]).toMatchObject({ firedCount: 2, waitingSince: NOW + 1000, state: 'waiting' });
    expect(jobs[0].history).toEqual([{ at: NOW + 500, state: 'waiting', reason: 'noSession' }]);
  });

  it('R9: origin limit → limit-reset job + synthetic open episode migrated-<id>, resetAt nextAt − 60000, marginMs 60000, source rule:migrated', () => {
    const { jobs, episodes } = migrateTimedMessagesV1(
      v1File([v1Schedule({ id: 'tm-limit', origin: 'limit', nextAt: NOW + HOUR })]),
      { maxAttempts: 3 },
    );
    expect(jobs[0]).toMatchObject({
      id: 'tm-limit',
      origin: 'limit',
      trigger: {
        kind: 'limit-reset',
        episodeId: 'migrated-tm-limit',
        resetAt: NOW + HOUR - 60_000,
        marginMs: 60_000,
      },
    });
    expect(episodes).toEqual([
      expect.objectContaining({
        id: 'migrated-tm-limit',
        sessionId: 's1',
        state: 'open',
        resetAt: NOW + HOUR - 60_000,
        source: 'rule:migrated',
      }),
    ]);
  });

  it('R9: attempts 0, maxAttempts from opts', () => {
    const { jobs } = migrateTimedMessagesV1(v1File([v1Schedule()]), { maxAttempts: 5 });
    expect(jobs[0]).toMatchObject({
      attempts: 0,
      maxAttempts: 5,
      id: 'tm-1',
      sessionId: 's1',
      createdAt: NOW,
      nextAt: NOW + 60_000,
      action: { kind: 'send', message: 'Continue' },
      origin: 'user',
    });
  });
});

describe('serializeSchedulerFile', () => {
  const ser = (file: SchedulerFile) => serializeSchedulerFile(file, NOW);

  it('serialize drops done time jobs and old terminal limit jobs', () => {
    const doneTime = job({ id: 'done-time', state: 'done' });
    const oldLimit = limitJob({
      id: 'old-limit',
      state: 'done',
      history: [{ at: NOW - 25 * HOUR, state: 'done' }],
    });
    const recentLimit = limitJob({
      id: 'recent-limit',
      state: 'done',
      history: [{ at: NOW - HOUR, state: 'done' }],
    });
    const live = job({ id: 'live', state: 'waiting' });
    const kept = JSON.parse(
      ser({
        version: 2,
        jobs: [doneTime, oldLimit, recentLimit, live],
        episodes: [],
      }),
    ) as SchedulerFile;
    expect(kept.jobs.map((j) => j.id)).toEqual(['recent-limit', 'live']);
  });

  it('keeps an episode only when a kept job references it or it is open', () => {
    const referenced = episode({ id: 'e1', state: 'resumed' });
    const open = episode({ id: 'e2', state: 'open' });
    const orphan = episode({ id: 'e3', state: 'closed' });
    const kept = JSON.parse(
      ser({
        version: 2,
        jobs: [
          limitJob({
            trigger: { kind: 'limit-reset', episodeId: 'e1', resetAt: NOW, marginMs: 0 },
          }),
        ],
        episodes: [referenced, open, orphan],
      }),
    ) as SchedulerFile;
    expect(kept.episodes.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('keeps at most 10 terminal limit jobs per session, newest kept', () => {
    const terminal = Array.from({ length: 12 }, (_, i) =>
      limitJob({
        id: `L${i}`,
        state: 'done',
        createdAt: NOW - i,
        history: [{ at: NOW - i, state: 'done' }],
      }),
    );
    const kept = JSON.parse(ser({ version: 2, jobs: terminal, episodes: [] })) as SchedulerFile;
    expect(kept.jobs).toHaveLength(10);
    expect(kept.jobs.map((j) => j.id)).toEqual(terminal.slice(0, 10).map((j) => j.id));
  });

  it('caps a job history at JOB_HISTORY_MAX on parse', () => {
    const history = Array.from({ length: JOB_HISTORY_MAX + 5 }, (_, i) => ({
      at: NOW + i,
      state: 'armed' as const,
    }));
    const blob = v2({ jobs: [job({ history })] });
    expect(parseSchedulerFile(blob, OPTS).jobs[0].history).toHaveLength(JOB_HISTORY_MAX);
  });
});

describe('parseSchedulerFile bounds (conductor ruling)', () => {
  it('uses opts.maxAttempts when a job has none', () => {
    const blob = JSON.stringify({
      version: 2,
      jobs: [{ ...job(), maxAttempts: undefined }],
      episodes: [],
    });
    expect(parseSchedulerFile(blob, { maxAttempts: 4 }).jobs[0].maxAttempts).toBe(4);
  });

  it('clamps maxAttempts to 1..5', () => {
    const blob = JSON.stringify({
      version: 2,
      jobs: [job({ id: 'hi', maxAttempts: 9 }), job({ id: 'lo', maxAttempts: 0 })],
      episodes: [],
    });
    const jobs = parseSchedulerFile(blob, OPTS).jobs;
    expect(jobs.map((j) => j.maxAttempts)).toEqual([5, 1]);
  });

  it('clamps attempts to 0..maxAttempts', () => {
    const blob = JSON.stringify({
      version: 2,
      jobs: [job({ id: 'over', attempts: 7, maxAttempts: 3 }), job({ id: 'under', attempts: -2 })],
      episodes: [],
    });
    const jobs = parseSchedulerFile(blob, OPTS).jobs;
    expect(jobs.map((j) => j.attempts)).toEqual([3, 0]);
  });

  it('caps non-terminal time jobs at MAX_TOTAL, first in file order wins', () => {
    const jobs = Array.from({ length: 21 }, (_, i) => job({ id: `t${i}` }));
    const kept = parseSchedulerFile(JSON.stringify({ version: 2, jobs, episodes: [] }), OPTS).jobs;
    expect(kept).toHaveLength(20);
    expect(kept[0].id).toBe('t0');
    expect(kept[19].id).toBe('t19');
  });
});

describe('serializeSchedulerFile retention uses the now argument', () => {
  it('drops a terminal limit job whose last entry is 24 h old at the given now', () => {
    const recent = limitJob({
      id: 'recent',
      state: 'done',
      history: [{ at: NOW - HOUR, state: 'done' }],
    });
    const kept = JSON.parse(
      serializeSchedulerFile({ version: 2, jobs: [recent], episodes: [] }, NOW + 2 * 24 * HOUR),
    ) as SchedulerFile;
    expect(kept.jobs).toEqual([]);
  });
});
