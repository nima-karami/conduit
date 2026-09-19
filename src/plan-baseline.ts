import type { PlanBlock } from './plan-blocks';
import type { PlanBaseline } from './plan-comments';

/**
 * The baseline is what separates the agent's writes from the human's edits: a block is
 * human-changed exactly when its hash is not in it. See the plan's "Settled decisions" for why it
 * is an ordered hash list rather than an accumulating set.
 */

export function seedBaseline(diskHashes: readonly string[], at: string): PlanBaseline {
  return { at, blockHashes: [...diskHashes] };
}

/** An external write replaces only what the agent changed, so a human edit the agent left alone
 *  stays outside the baseline and keeps reading as changed. */
export function advanceBaseline(
  b: PlanBaseline,
  prevDiskHashes: readonly string[],
  nextDiskHashes: readonly string[],
  at: string,
): PlanBaseline {
  const next = new Set(nextDiskHashes);
  const prev = new Set(prevDiskHashes);
  const kept = b.blockHashes.filter((h) => next.has(h) || !prev.has(h));
  const present = new Set(kept);
  const blockHashes = [...kept];
  for (const h of nextDiskHashes) {
    if (prev.has(h) || present.has(h)) continue;
    present.add(h);
    blockHashes.push(h);
  }
  return { at, blockHashes };
}

export function humanChanged(blocks: readonly PlanBlock[], b: PlanBaseline): PlanBlock[] {
  const known = new Set(b.blockHashes);
  return blocks.filter((block) => !known.has(block.hash));
}

export function removedSinceBaseline(blocks: readonly PlanBlock[], b: PlanBaseline): number {
  return Math.max(0, b.blockHashes.length - blocks.length);
}
