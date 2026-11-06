export interface RepeatShard {
  index: number;
  names: string[];
  runs: number;
  attemptBase: number;
}
export function repeatMatrix(names: string[], repeat: number): { shards: RepeatShard[] };
export function plannedAttempts(
  shards: { index: number; names: string[]; runs?: number; attemptBase?: number }[],
): { name: string; shard: number; attempt: number }[];
