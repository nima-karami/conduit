export interface RepeatShard {
  index: number;
  names: string[];
  runs: number;
}
export function repeatMatrix(names: string[], repeat: number): { shards: RepeatShard[] };
