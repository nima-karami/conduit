export interface ResultRow {
  name: string;
  status: string;
  seconds: number;
  attempts?: number;
  attempt?: number;
  shard: number | null;
  artifact?: string;
  reason?: string;
  alsoFailingOnNightly?: boolean;
  exit?: number | string | null;
}
export interface QuarantineCandidate {
  name: string;
  count: number;
  last: string;
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
  lastNightlySha: string | null;
  quarantineCandidates: QuarantineCandidate[];
  warnings: string[];
  results: ResultRow[];
}
export function runStatus(
  results: { status: string; attempt?: number }[],
  opts?: { verify?: string; prepare?: string },
): string;
export function repeatRates(
  results: { name: string; status: string; attempt?: number; shard?: number | null }[],
): { name: string; passed: number; total: number; failures: string[] }[];
export function infraRerunLine(
  results: { name: string; status: string }[],
  sha?: string,
): string | null;
export function mergeResults(
  plan: { shards: { index: number; names: string[] }[] },
  shardFiles: {
    shard: number;
    results: {
      name: string;
      status: string;
      seconds: number;
      attempts?: number;
      attempt?: number;
      exit?: number | string | null;
    }[];
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
    lastNightly?: { sha: string; runId?: number; at?: string; failing: string[] } | null;
    quarantine?: { scenarios?: Record<string, { reason: string; since: string }> } | null;
    quarantineCandidates?: QuarantineCandidate[];
  },
): ResultJson;
export function countByStatus(results: { status: string }[]): Record<string, number>;
export function summaryMarkdown(result: ResultJson): string;
