export const EXIT_WATCHDOG: 124;
export type ScenarioStatus = 'PASS' | 'SKIP' | 'TIMEOUT' | 'FAIL' | 'FLAKY' | 'QUARANTINED-FAIL';

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
}): 'PASS' | 'SKIP' | 'TIMEOUT' | 'FAIL';
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
export const RUN_MARKER: '--conduit-e2e-run';
export function orphanVictims(
  procs: { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[],
  runId: string,
): number[];
