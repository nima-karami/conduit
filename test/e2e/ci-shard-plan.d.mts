export interface Shard {
  index: number;
  names: string[];
  estSec: number;
}

export function planShards(
  names: string[],
  timings: Record<string, number>,
  opts?: { shards?: number; targetSec?: number; cap?: number; scale?: number; setupSec?: number },
): { shards: Shard[] };
