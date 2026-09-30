export const USAGE: string;
export interface RemoteArgs {
  full: boolean;
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
export function selectionKey(o: { full: boolean; names: string[]; verify: boolean }): string;
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
export function formatResults(result: {
  status: string;
  sha: string;
  url?: string;
  verify?: string;
  rerun?: string | null;
  results: {
    name: string;
    status: string;
    seconds: number;
    shard: number | null;
    artifact?: string;
    reason?: string;
  }[];
}): string;
