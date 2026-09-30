export interface StateRow {
  name: string;
  status: string;
  seconds: number;
}
export interface Timings {
  samples: Record<string, number[]>;
  medians: Record<string, number>;
}
export type FlakyHistory = Record<string, string[]>;
export interface QuarantineCandidate {
  name: string;
  count: number;
  last: string;
}
export interface LastNightly {
  sha: string;
  runId: number;
  at: string;
  failing: string[];
}
export function updateTimings(
  prev: { samples?: Record<string, number[]> } | null,
  rows: StateRow[],
): Timings;
export function resolveTimings(
  seed: { scale?: number; medians: Record<string, number> },
  state: { medians?: Record<string, number> } | null,
): { medians: Record<string, number>; source: 'seed' | 'e2e-state' };
export function updateFlakyHistory(
  prev: FlakyHistory | null,
  rows: StateRow[],
  o: { now: number; days?: number },
): FlakyHistory;
export function quarantineCandidates(
  history: FlakyHistory | null,
  o: { now: number; days?: number; min?: number },
): QuarantineCandidate[];
export function lastNightly(
  rows: { name: string; status: string }[],
  o: { sha: string; runId: number; at: string },
): LastNightly;
export function newestArtifact<T extends { name: string; expired: boolean; created_at: string }>(
  list: { artifacts?: T[] } | null,
  name: string,
): T | null;
export function staleCiRefs(
  refs: { ref: string; commitAt: string; runs: { status: string; created_at: string }[] }[],
  o: { now: number; maxAgeMs?: number },
): string[];
