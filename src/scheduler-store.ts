// see docs/specs/2026-11-13-scheduler-auto-resume.md §3 "Job (persisted)" and R9

import { CLI_KINDS, type CliKind } from './conduit-mcp/tool-policy';
import type { SignalSource } from './contracts/auto-resume';
import {
  JOB_HISTORY_MAX,
  type Job,
  type JobHistoryEntry,
  type JobState,
  type JobTrigger,
  type LimitEpisode,
  type SchedulerFile,
  TERMINAL_JOB_STATES,
} from './contracts/scheduler';
import { judgePersistedVersion } from './contracts/session-identity';
import { normalizeMessage } from './message-text';
import type { FireOutcome } from './scheduler';
import {
  type LastFire,
  MAX_EPOCH_MS,
  MAX_INTERVAL_MS,
  MAX_REPEATS,
  MAX_TOTAL,
  type TimedMessage,
  type TimedMessagesFile,
} from './timed-messages';

const HOUR_MS = 3_600_000;
const LIMIT_RECORD_KEEP_MS = 24 * HOUR_MS;
const TERMINAL_LIMIT_KEEP_PER_SESSION = 10;
const MIGRATED_MARGIN_MS = 60_000;
const MAX_ATTEMPTS_CEILING = 5;

const JOB_STATES: readonly JobState[] = [
  'proposed',
  'armed',
  'waiting',
  'checking',
  'sending',
  'verifying',
  'done',
  'skipped',
  'failed',
  'cancelled',
];
const ORIGINS: readonly Job['origin'][] = ['user', 'limit', 'mcp'];
const EPISODE_STATES: readonly LimitEpisode['state'][] = ['open', 'resumed', 'expired', 'closed'];
const FIXED_SOURCES: readonly Exclude<SignalSource, `rule:${string}`>[] = [
  'claude-hook',
  'claude-statusline',
  'codex-rollout',
  'attention',
  'human-input',
];

interface ParseOpts {
  maxAttempts: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSafeInt = (v: unknown, lo: number, hi = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;

function optionalInt(v: unknown, lo: number, hi?: number): number | undefined | null {
  if (v === undefined) return undefined;
  return isSafeInt(v, lo, hi) ? v : null;
}

const isJobState = (v: unknown): v is JobState => JOB_STATES.some((s) => s === v);
const isOrigin = (v: unknown): v is Job['origin'] => ORIGINS.some((o) => o === v);
const isEpisodeState = (v: unknown): v is LimitEpisode['state'] =>
  EPISODE_STATES.some((s) => s === v);
const isCli = (v: unknown): v is CliKind | 'other' =>
  v === 'other' || CLI_KINDS.some((k) => k === v);

function isSignalSource(v: unknown): v is SignalSource {
  if (typeof v !== 'string') return false;
  return v.startsWith('rule:') || FIXED_SOURCES.some((s) => s === v);
}

function fireOutcomeOf(lastFire: LastFire): FireOutcome {
  if (lastFire.delivered) return lastFire.late ? 'delivered late' : 'delivered';
  return lastFire.reason === 'expired' ? 'expired' : 'no session';
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Time jobs past MAX_TOTAL are dropped; the first ones in file order win, as parseTimedMessagesFile did. */
function capTimeJobs(jobs: Job[]): Job[] {
  let live = 0;
  return jobs.filter((j) => {
    if (j.trigger.kind === 'limit-reset' || TERMINAL_JOB_STATES.includes(j.state)) return true;
    if (live >= MAX_TOTAL) return false;
    live += 1;
    return true;
  });
}

function emptyFile(): SchedulerFile {
  return { version: 2, jobs: [], episodes: [] };
}

function parseTrigger(v: unknown): JobTrigger | null {
  if (!isRecord(v)) return null;
  switch (v.kind) {
    case 'in':
      return isSafeInt(v.delayMs, 0) ? { kind: 'in', delayMs: v.delayMs } : null;
    case 'at': {
      if (typeof v.clock !== 'string') return null;
      if (v.zone !== undefined && typeof v.zone !== 'string') return null;
      return {
        kind: 'at',
        clock: v.clock,
        ...(typeof v.zone === 'string' ? { zone: v.zone } : {}),
      };
    }
    case 'every':
      return isSafeInt(v.everyMs, 1, MAX_INTERVAL_MS) && isSafeInt(v.maxRepeats, 1, MAX_REPEATS)
        ? { kind: 'every', everyMs: v.everyMs, maxRepeats: v.maxRepeats }
        : null;
    case 'limit-reset':
      return typeof v.episodeId === 'string' &&
        isSafeInt(v.resetAt, 0, MAX_EPOCH_MS) &&
        isSafeInt(v.marginMs, 0)
        ? {
            kind: 'limit-reset',
            episodeId: v.episodeId,
            resetAt: v.resetAt,
            marginMs: v.marginMs,
          }
        : null;
    default:
      return null;
  }
}

function parseAction(v: unknown): Job['action'] | null {
  if (!isRecord(v) || v.kind !== 'send' || typeof v.message !== 'string') return null;
  const check = normalizeMessage(v.message);
  return check.ok ? { kind: 'send', message: check.message } : null;
}

function parseHistory(v: unknown): JobHistoryEntry[] {
  if (!Array.isArray(v)) return [];
  const entries: JobHistoryEntry[] = [];
  for (const e of v) {
    if (!isRecord(e) || !isSafeInt(e.at, 0) || !isJobState(e.state)) continue;
    entries.push({
      at: e.at,
      state: e.state,
      ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    });
  }
  return entries.slice(-JOB_HISTORY_MAX);
}

function parseJob(v: unknown, fallbackMaxAttempts: number): Job | null {
  if (!isRecord(v)) return null;
  const trigger = parseTrigger(v.trigger);
  const action = parseAction(v.action);
  const firedCount = optionalInt(v.firedCount, 0, MAX_REPEATS);
  const waitingSince = optionalInt(v.waitingSince, 0);
  const maxAttempts = clamp(
    isSafeInt(v.maxAttempts, 0) ? v.maxAttempts : fallbackMaxAttempts,
    1,
    MAX_ATTEMPTS_CEILING,
  );
  if (
    typeof v.id !== 'string' ||
    typeof v.sessionId !== 'string' ||
    !isOrigin(v.origin) ||
    !trigger ||
    !action ||
    !isJobState(v.state) ||
    !isSafeInt(v.nextAt, 0, MAX_EPOCH_MS) ||
    !isSafeInt(v.attempts, Number.MIN_SAFE_INTEGER) ||
    !isSafeInt(v.createdAt, 0, MAX_EPOCH_MS) ||
    firedCount === null ||
    waitingSince === null
  ) {
    return null;
  }
  return {
    id: v.id,
    sessionId: v.sessionId,
    origin: v.origin,
    trigger,
    action,
    nextAt: v.nextAt,
    state: v.state,
    attempts: clamp(v.attempts, 0, maxAttempts),
    maxAttempts,
    createdAt: v.createdAt,
    history: parseHistory(v.history),
    ...(firedCount === undefined ? {} : { firedCount }),
    ...(waitingSince === undefined ? {} : { waitingSince }),
  };
}

function parseEpisode(v: unknown): LimitEpisode | null {
  if (!isRecord(v)) return null;
  const resetAtOk = v.resetAt === null || isSafeInt(v.resetAt, 0, MAX_EPOCH_MS);
  if (
    typeof v.id !== 'string' ||
    typeof v.sessionId !== 'string' ||
    !isCli(v.cli) ||
    !isSafeInt(v.startedAt, 0) ||
    !resetAtOk ||
    !isSignalSource(v.source) ||
    !isEpisodeState(v.state)
  ) {
    return null;
  }
  return {
    id: v.id,
    sessionId: v.sessionId,
    cli: v.cli,
    startedAt: v.startedAt,
    resetAt: typeof v.resetAt === 'number' ? v.resetAt : null,
    source: v.source,
    state: v.state,
  };
}

/**
 * A corrupt or foreign-version file is an EMPTY set, never an error: the next write replaces it.
 * A newer file is empty too, and flagged so the caller never overwrites it.
 */
export function parseSchedulerFile(blob: string | null, opts: ParseOpts): SchedulerFile {
  if (blob === null) return emptyFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return emptyFile();
  }
  if (!isRecord(parsed)) return emptyFile();
  const verdict = judgePersistedVersion('scheduler.json', parsed.version);
  if (verdict === 'newer') return { version: 2, jobs: [], episodes: [], kind: 'newer' };
  if (verdict !== 'read' || parsed.version !== 2) return emptyFile();
  if (!Array.isArray(parsed.jobs) || !Array.isArray(parsed.episodes)) return emptyFile();
  return {
    version: 2,
    jobs: capTimeJobs(
      parsed.jobs.map((j) => parseJob(j, opts.maxAttempts)).filter((j): j is Job => j !== null),
    ),
    episodes: parsed.episodes.map(parseEpisode).filter((e): e is LimitEpisode => e !== null),
  };
}

/**
 * Terminal limit-reset jobs are kept 24 h for `scheduler.history`, at most 10 per session,
 * newest first. Done time jobs are not kept: the next launch has nothing to renew.
 */
function keptJobs(jobs: readonly Job[], now: number): Job[] {
  const keep = new Set<string>();
  const keptPerSession = new Map<string, number>();
  const newestFirst = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  for (const j of newestFirst) {
    if (!TERMINAL_JOB_STATES.includes(j.state)) {
      keep.add(j.id);
      continue;
    }
    if (j.trigger.kind !== 'limit-reset' || j.history.length === 0) continue;
    const lastAt = j.history[j.history.length - 1].at;
    if (now - lastAt >= LIMIT_RECORD_KEEP_MS) continue;
    const kept = keptPerSession.get(j.sessionId) ?? 0;
    if (kept >= TERMINAL_LIMIT_KEEP_PER_SESSION) continue;
    keptPerSession.set(j.sessionId, kept + 1);
    keep.add(j.id);
  }
  return jobs.filter((j) => keep.has(j.id));
}

export function serializeSchedulerFile(file: SchedulerFile, now: number): string {
  const jobs = keptJobs(file.jobs, now);
  const referenced = new Set(
    jobs.flatMap((j) => (j.trigger.kind === 'limit-reset' ? [j.trigger.episodeId] : [])),
  );
  const episodes = file.episodes.filter((e) => e.state === 'open' || referenced.has(e.id));
  return JSON.stringify({ version: 2, jobs, episodes }, null, 2);
}

function timeTrigger(s: TimedMessage): JobTrigger | null {
  if (s.kind === 'interval') {
    if (s.everyMs === undefined) return null;
    return { kind: 'every', everyMs: s.everyMs, maxRepeats: s.maxRepeats };
  }
  if (s.spec) {
    return {
      kind: 'at',
      clock: s.spec.clock,
      ...(s.spec.zone !== undefined ? { zone: s.spec.zone } : {}),
    };
  }
  return { kind: 'in', delayMs: Math.max(s.nextAt - s.createdAt, 0) };
}

/**
 * R9, field by field. A v1 limit schedule becomes a limit-reset job on a synthetic open episode,
 * so the first start after the upgrade still has the pre-fire check and the verify window.
 */
export function migrateTimedMessagesV1(
  v1: TimedMessagesFile,
  opts: { maxAttempts: number },
): { jobs: Job[]; episodes: LimitEpisode[] } {
  const jobs: Job[] = [];
  const episodes: LimitEpisode[] = [];
  for (const s of v1.schedules) {
    const check = normalizeMessage(s.message);
    if (!check.ok) continue;
    const history: JobHistoryEntry[] = s.lastFire
      ? [{ at: s.lastFire.at, state: s.state, reason: fireOutcomeOf(s.lastFire) }]
      : [];
    const action: Job['action'] = { kind: 'send', message: check.message };
    const base = {
      id: s.id,
      sessionId: s.sessionId,
      action,
      nextAt: s.nextAt,
      state: s.state,
      attempts: 0,
      maxAttempts: opts.maxAttempts,
      createdAt: s.createdAt,
      history,
      ...(s.waitingSince === undefined ? {} : { waitingSince: s.waitingSince }),
    };
    if (s.origin === 'limit') {
      const episodeId = `migrated-${s.id}`;
      const resetAt = s.nextAt - MIGRATED_MARGIN_MS;
      episodes.push({
        id: episodeId,
        sessionId: s.sessionId,
        cli: 'other',
        startedAt: s.createdAt,
        resetAt,
        source: 'rule:migrated',
        state: 'open',
      });
      jobs.push({
        ...base,
        origin: 'limit',
        trigger: { kind: 'limit-reset', episodeId, resetAt, marginMs: MIGRATED_MARGIN_MS },
      });
      continue;
    }
    const trigger = timeTrigger(s);
    if (trigger === null) continue;
    jobs.push({ ...base, origin: 'user', trigger, firedCount: s.firedCount });
  }
  return { jobs, episodes };
}
