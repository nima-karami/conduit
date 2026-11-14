// Scheduler jobs and limit episodes, persisted in userData/scheduler.json.
// see docs/specs/2026-11-13-scheduler-auto-resume.md §3 "Job (persisted)"
import type { CliKind } from '../conduit-mcp/tool-policy';
import type { SignalSource } from './auto-resume';

export type JobTrigger =
  | { kind: 'in'; delayMs: number }
  | { kind: 'at'; clock: string; zone?: string }
  | { kind: 'every'; everyMs: number; maxRepeats: number }
  | { kind: 'limit-reset'; episodeId: string; resetAt: number; marginMs: number };

export type JobAction = { kind: 'send'; message: string };

/** `proposed` is R8's ask-mode state: it never fires until accepted. */
export type JobState =
  | 'proposed'
  | 'armed'
  | 'waiting'
  | 'checking'
  | 'sending'
  | 'verifying'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export const TERMINAL_JOB_STATES: readonly JobState[] = ['done', 'skipped', 'failed', 'cancelled'];
export const JOB_HISTORY_MAX = 20;

export interface JobHistoryEntry {
  at: number;
  state: JobState;
  reason?: string;
}

export interface Job {
  id: string;
  sessionId: string;
  origin: 'user' | 'limit' | 'mcp';
  trigger: JobTrigger;
  action: JobAction;
  nextAt: number;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  history: JobHistoryEntry[];
  /** Time jobs only (R9). */
  firedCount?: number;
  waitingSince?: number;
}

export interface LimitEpisode {
  id: string;
  sessionId: string;
  cli: CliKind | 'other';
  startedAt: number;
  resetAt: number | null;
  source: SignalSource;
  state: 'open' | 'resumed' | 'expired' | 'closed';
}

export interface SchedulerFile {
  version: 2;
  jobs: Job[];
  episodes: LimitEpisode[];
  kind?: 'newer';
}

export type PreFireVerdict = { go: true } | { go: false; reason: string };
export type DeliveryResult = { ok: true; joined: boolean } | { ok: false; reason: string };
export type AutoResumeMode = 'on' | 'ask' | 'off';
export type SessionAutoResume = 'inherit' | 'on' | 'off';
