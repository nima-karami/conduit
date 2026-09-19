import { describe, expect, it } from 'vitest';
import {
  advanceBaseline,
  humanChanged,
  removedSinceBaseline,
  seedBaseline,
} from '../../src/plan-baseline';
import type { PlanBlock } from '../../src/plan-blocks';
import { splitPlan } from '../../src/plan-blocks';
import type { PlanBaseline } from '../../src/plan-comments';

const AT = '2026-09-19T10:00:00.000Z';
const LATER = '2026-09-19T11:00:00.000Z';

const baseline = (blockHashes: string[], at = AT): PlanBaseline => ({ at, blockHashes });

function blocksOf(markdown: string): PlanBlock[] {
  return splitPlan(markdown).blocks;
}

describe('seedBaseline', () => {
  it('copies the disk hashes in order', () => {
    const disk = ['h1', 'h2', 'h3'];
    const b = seedBaseline(disk, AT);
    expect(b).toEqual({ at: AT, blockHashes: ['h1', 'h2', 'h3'] });
  });

  it('copies rather than aliases the input', () => {
    const disk = ['h1', 'h2'];
    const b = seedBaseline(disk, AT);
    expect(b.blockHashes).not.toBe(disk);
    b.blockHashes.push('h3');
    expect(disk).toEqual(['h1', 'h2']);
  });
});

describe('advanceBaseline', () => {
  it('drops hashes that vanished and appends hashes that appeared, keeping the rest in order', () => {
    const b = baseline(['a', 'b', 'c']);
    const next = advanceBaseline(b, ['a', 'b', 'c'], ['a', 'c2', 'd'], LATER);
    expect(next).toEqual({ at: LATER, blockHashes: ['a', 'c2', 'd'] });
  });

  it('keeps the surviving baseline order, appending what appeared at the end', () => {
    const b = baseline(['a', 'b', 'c']);
    const next = advanceBaseline(b, ['c', 'b', 'a'], ['z', 'c', 'a'], LATER);
    expect(next.blockHashes).toEqual(['a', 'c', 'z']);
  });

  it('is a no-op on the hash list when the disk did not change', () => {
    const b = baseline(['a', 'b']);
    expect(advanceBaseline(b, ['a', 'b'], ['a', 'b'], LATER)).toEqual({
      at: LATER,
      blockHashes: ['a', 'b'],
    });
  });

  it('never duplicates a hash that is already in the baseline', () => {
    const b = baseline(['a', 'b']);
    expect(advanceBaseline(b, [], ['a', 'b'], LATER).blockHashes).toEqual(['a', 'b']);
  });

  it('leaves an unsent human hash outside the baseline', () => {
    // Baseline [a,b]; the human edited b -> b2 and it is on disk (prev [a,b2]); the agent
    // then changes a -> a2 (next [a2,b2]). b2 must stay out, so it still reads as changed.
    const b = baseline(['a', 'b']);
    const next = advanceBaseline(b, ['a', 'b2'], ['a2', 'b2'], LATER);
    expect(next.blockHashes).toEqual(['b', 'a2']);
    expect(next.blockHashes).not.toContain('b2');
  });

  it('does not mutate the baseline it is given', () => {
    const b = baseline(['a', 'b']);
    advanceBaseline(b, ['a', 'b'], ['c'], LATER);
    expect(b).toEqual({ at: AT, blockHashes: ['a', 'b'] });
  });
});

describe('humanChanged', () => {
  const doc = ['# Alpha', '', 'Prose one.', '', 'Prose two.', ''].join('\n');

  it('lists the blocks whose hash is outside the baseline', () => {
    const blocks = blocksOf(doc);
    const b = baseline([blocks[0].hash, blocks[2].hash]);
    expect(humanChanged(blocks, b).map((x) => x.index)).toEqual([1]);
  });

  it('is empty when every hash is in the baseline', () => {
    const blocks = blocksOf(doc);
    expect(humanChanged(blocks, baseline(blocks.map((x) => x.hash)))).toEqual([]);
  });

  it('counts a revert to an earlier text as changed', () => {
    const original = blocksOf(doc);
    const edited = blocksOf(doc.replace('Prose one.', 'Prose one, revised.'));
    // The agent's write moved the baseline off the original hash.
    const b = advanceBaseline(
      seedBaseline(
        original.map((x) => x.hash),
        AT,
      ),
      original.map((x) => x.hash),
      edited.map((x) => x.hash),
      LATER,
    );
    expect(humanChanged(edited, b)).toEqual([]);
    expect(humanChanged(original, b).map((x) => x.index)).toEqual([1]);
  });
});

describe('removedSinceBaseline', () => {
  it('is max(0, baseline.length - blocks.length)', () => {
    const blocks = blocksOf(['# Alpha', '', 'Prose one.', ''].join('\n'));
    expect(blocks).toHaveLength(2);
    expect(removedSinceBaseline(blocks, baseline(['a', 'b', 'c', 'd']))).toBe(2);
    expect(removedSinceBaseline(blocks, baseline(['a', 'b']))).toBe(0);
    expect(removedSinceBaseline(blocks, baseline(['a']))).toBe(0);
    expect(removedSinceBaseline([], baseline(['a', 'b']))).toBe(2);
  });
});
