export interface ResultRow {
  name: string;
  status: string;
  seconds: number;
  attempts: number;
  shard: number | null;
  artifact?: string;
  reason?: string;
}
export interface ResultJson {
  sha: string;
  nonce: string;
  selection: string;
  runId?: number;
  url?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  verify?: string;
  prepare?: string;
  shards: number;
  status: string;
  rerun: string | null;
  results: ResultRow[];
}
export function runStatus(
  results: { status: string }[],
  opts?: { verify?: string; prepare?: string },
): string;
export function infraRerunLine(
  results: { name: string; status: string }[],
  sha?: string,
): string | null;
export function mergeResults(
  plan: { shards: { index: number; names: string[] }[] },
  shardFiles: {
    shard: number;
    results: { name: string; status: string; seconds: number; attempts?: number }[];
  }[],
  meta: {
    sha: string;
    nonce: string;
    selection: string;
    runId?: number;
    url?: string;
    queuedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    verify?: string;
    prepare?: string;
    artifactUrls?: Record<number, string>;
    excluded?: Record<string, string>;
  },
): ResultJson;
export function countByStatus(results: { status: string }[]): Record<string, number>;
export function summaryMarkdown(result: ResultJson): string;
