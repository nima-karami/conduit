export const EXIT_WATCHDOG: 124;
export type ScenarioStatus = 'PASS' | 'SKIP' | 'TIMEOUT' | 'FAIL' | 'FLAKY';

export function parseRunnerArgs(argv: string[]):
  | {
      names: string[];
      namesFile: string | null;
      json: string | null;
      artifacts: string | null;
      retry: boolean;
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
  errorCode?: string;
  output?: string;
}): 'PASS' | 'SKIP' | 'TIMEOUT' | 'FAIL';
export function finalStatus(first: ScenarioStatus, retry?: ScenarioStatus): ScenarioStatus;
export function isGreen(status: string): boolean;
