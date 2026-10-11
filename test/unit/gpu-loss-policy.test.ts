import { describe, expect, it } from 'vitest';
import { GPU_GIVE_UP_LOSSES, GPU_LOSS_WINDOW_MS, noteGpuLoss } from '../../webview/gpu-loss-policy';

const lossesAt = (times: number[]) => {
  let losses: number[] = [];
  let exhausted = false;
  for (const t of times) ({ losses, exhausted } = noteGpuLoss(losses, t));
  return { losses, exhausted };
};

describe('GPU loss policy', () => {
  it(`allows ${GPU_GIVE_UP_LOSSES} losses inside the window`, () => {
    expect(lossesAt([0, 1, 2]).exhausted).toBe(false);
  });

  it(`is exhausted by loss ${GPU_GIVE_UP_LOSSES + 1} inside the window`, () => {
    expect(lossesAt([0, 1, 2, 3]).exhausted).toBe(true);
  });

  it('forgets losses older than the window', () => {
    const step = GPU_LOSS_WINDOW_MS / 2;
    const r = lossesAt([0, step, 2 * step, 3 * step, 4 * step]);
    expect(r.exhausted).toBe(false);
    expect(r.losses).toEqual([3 * step, 4 * step]);
  });
});
