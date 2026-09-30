export const DEFAULT_PIPE: string;
export function acquireE2eLock(opts?: {
  pipePath?: string;
  scenario?: string;
  pollMs?: number;
  log?: (line: string) => void;
}): Promise<void>;
export function releaseE2eLock(): void;
export function setBelowNormal(pids?: number[]): void;
