export const EXIT_WATCHDOG: 124;
export type ScenarioStatus =
  | 'PASS'
  | 'SKIP'
  | 'TIMEOUT'
  | 'FAIL'
  | 'FLAKY'
  | 'QUARANTINED-FAIL'
  | 'LOCK-TIMEOUT';

export function parseRunnerArgs(argv: string[]):
  | {
      names: string[];
      namesFile: string | null;
      json: string | null;
      artifacts: string | null;
      retry: boolean;
      quarantine: string | null;
    }
  | { error: string };
export function resolveSelection(o: {
  names: string[];
  stems: string[];
  ci: boolean;
  localFull: boolean;
}): { names: string[]; banner?: string } | { exit: number; message: string };
export function applyExclusions(
  names: string[],
  exclusions: Record<string, string>,
): { run: string[]; excluded: Record<string, string> };
export function classify(r: {
  status: number | null;
  signal?: string | null;
  output?: string;
  lockTimeout?: boolean;
}): 'PASS' | 'SKIP' | 'TIMEOUT' | 'FAIL' | 'LOCK-TIMEOUT';
export function finalStatus(first: ScenarioStatus, retry?: ScenarioStatus): ScenarioStatus;
export function applyQuarantine(
  name: string,
  status: ScenarioStatus,
  quarantine: { scenarios?: Record<string, { reason: string; since: string }> } | null,
): ScenarioStatus;
export function isGreen(status: string): boolean;
export function watchdogDelayMs(o: {
  deadlineMs: number;
  uptimeMs: number;
  lockWaitMs: number;
}): number;
export function lockWaitMsFromLine(line: string): number | null;
export const KILL_TIMER_LOCK_CAP_MS: number;
export interface KillTimer {
  start: number;
  killMs: number;
  waitCapMs: number;
  waitedMs: number;
  waitingSince: number | null;
  deadline: number;
  reason: 'run' | 'lock-wait';
}
export function killTimerStart(start: number, o: { killMs: number; waitCapMs?: number }): KillTimer;
export function killTimerOnLine(state: KillTimer, line: string, now: number): KillTimer;
export const RUN_MARKER: '--conduit-e2e-run';
export function profilePrefix(runId: string): string;
export function orphanVictims(
  procs: { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[],
  runId: string,
): number[];
