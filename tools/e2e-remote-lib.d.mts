export const USAGE: string;
export interface RemoteArgs {
  full: boolean;
  affected: boolean;
  names: string[];
  shards: number;
  wait: boolean;
  verify: boolean;
  out: string | null;
  timeoutMin: number;
}
export interface RunListItem {
  databaseId: number;
  displayTitle: string;
  status: string;
  headSha: string;
  url: string;
}
export function parseArgs(argv: string[]): RemoteArgs | { error: string };
export function selectionKey(o: {
  full: boolean;
  affected?: boolean;
  names: string[];
  verify: boolean;
  base?: string;
}): string;
export function makeNonce(selKey: string, rand: string): string;
export function parseTitle(
  title: string,
): { selection: string; nonce: string; selKey: string | null } | null;
export function matchInFlight(
  runs: RunListItem[],
  o: { sha: string; selKey: string; full: boolean },
): { attach: RunListItem } | { waitFor: RunListItem } | { dispatch: true };
export function runState(view: {
  status: string;
  jobs?: { name: string; status: string }[];
}): string;
export function finalStatus(conclusion: string, result?: { status: string } | null): string;
export function exitCodeFor(status: string): number;
export function checkExclusions(
  names: string[],
  exclusions: Record<string, string>,
): { refuse?: string; notice?: string };
export function formatResults(result: {
  status: string;
  sha: string;
  url?: string;
  verify?: string;
  rerun?: string | null;
  lastNightlySha?: string | null;
  quarantineCandidates?: { name: string; count: number; last: string }[];
  warnings?: string[];
  results: {
    name: string;
    status: string;
    seconds: number;
    shard: number | null;
    artifact?: string;
    reason?: string;
    alsoFailingOnNightly?: boolean;
  }[];
}): string;
export function isTransientGhError(message: unknown): boolean;
export function withGhRetry<T>(
  fn: () => T | Promise<T>,
  o: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    sleep: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  },
): Promise<T>;
