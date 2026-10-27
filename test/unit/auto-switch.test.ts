import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../src/types';
import { pickAutoSwitch } from '../../webview/auto-switch';

const s = (id: string, createdAt: number, status: SessionStatus = 'running') => ({
  id,
  status,
  createdAt,
});

describe('pickAutoSwitch', () => {
  it('newest running added session wins', () => {
    expect(pickAutoSwitch([s('a', 1), s('b', 3), s('c', 2)], new Set())).toBe('b');
  });

  it('suppressed id is skipped, next newest wins', () => {
    expect(pickAutoSwitch([s('a', 1), s('b', 3), s('c', 2)], new Set(['b']))).toBe('c');
  });

  it('only suppressed → undefined', () => {
    expect(pickAutoSwitch([s('a', 1)], new Set(['a']))).toBeUndefined();
  });

  it('non-running ignored', () => {
    expect(pickAutoSwitch([s('a', 5, 'stale'), s('b', 1)], new Set())).toBe('b');
    expect(pickAutoSwitch([s('a', 5, 'exited')], new Set())).toBeUndefined();
  });
});
