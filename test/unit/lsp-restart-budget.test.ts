import { describe, expect, it } from 'vitest';
import { nextRestart, RESTART_DELAYS_MS, RESTART_WINDOW_MS } from '../../src/lsp-restart-budget';

describe('nextRestart', () => {
  it('delays 1s, 4s, 16s then null', () => {
    const a = nextRestart([], 1_000);
    expect(a?.delayMs).toBe(1000);
    const b = nextRestart(a?.history ?? [], 2_000);
    expect(b?.delayMs).toBe(4000);
    const c = nextRestart(b?.history ?? [], 3_000);
    expect(c?.delayMs).toBe(16000);
    expect([a?.delayMs, b?.delayMs, c?.delayMs]).toEqual([...RESTART_DELAYS_MS]);
    expect(c?.history).toEqual([1_000, 2_000, 3_000]);
    expect(nextRestart(c?.history ?? [], 4_000)).toBeNull();
  });

  it('entries older than 5 min fall out', () => {
    const now = 10 * RESTART_WINDOW_MS;
    const old = [now - RESTART_WINDOW_MS - 1, now - RESTART_WINDOW_MS, now - 1];
    expect(nextRestart(old, now)).toEqual({ delayMs: 4000, history: [now - 1, now] });
  });
});
