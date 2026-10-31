import { describe, expect, it } from 'vitest';
import { createWindowPresence } from '../../src/window-presence';

describe('createWindowPresence', () => {
  it('an unknown window is neither ready nor showing', () => {
    const p = createWindowPresence();
    expect(p.isReady(1)).toBe(false);
    expect(p.isOnScreen(1, 's1')).toBe(false);
  });

  it('ready + visible → on screen; unreported id → false', () => {
    const p = createWindowPresence();
    p.markReady(1);
    expect(p.isReady(1)).toBe(true);
    expect(p.isOnScreen(1, 's1')).toBe(false);
    p.setVisible(1, ['s1']);
    expect(p.isOnScreen(1, 's1')).toBe(true);
    expect(p.isOnScreen(1, 's2')).toBe(false);
    p.setVisible(1, ['s2']);
    expect(p.isOnScreen(1, 's1')).toBe(false);
    expect(p.isOnScreen(1, 's2')).toBe(true);
  });

  it('visible before ready counts once ready', () => {
    const p = createWindowPresence();
    p.setVisible(1, ['s1']);
    expect(p.isOnScreen(1, 's1')).toBe(false);
    p.markReady(1);
    expect(p.isOnScreen(1, 's1')).toBe(true);
  });

  it('startLoading clears both', () => {
    const p = createWindowPresence();
    p.markReady(1);
    p.setVisible(1, ['s1']);
    p.startLoading(1);
    expect(p.isReady(1)).toBe(false);
    expect(p.isOnScreen(1, 's1')).toBe(false);
    p.markReady(1);
    expect(p.isReady(1)).toBe(true);
    expect(p.isOnScreen(1, 's1')).toBe(false);
  });

  it('windows are independent', () => {
    const p = createWindowPresence();
    p.markReady(1);
    p.setVisible(1, ['s1']);
    p.markReady(2);
    p.setVisible(2, ['s2']);
    expect(p.isOnScreen(1, 's2')).toBe(false);
    expect(p.isOnScreen(2, 's2')).toBe(true);
    p.startLoading(2);
    expect(p.isOnScreen(1, 's1')).toBe(true);
    expect(p.isReady(2)).toBe(false);
  });

  it('drop forgets', () => {
    const p = createWindowPresence();
    p.markReady(1);
    p.setVisible(1, ['s1']);
    p.drop(1);
    expect(p.isReady(1)).toBe(false);
    expect(p.isOnScreen(1, 's1')).toBe(false);
    p.setVisible(1, ['s1']);
    expect(p.isOnScreen(1, 's1')).toBe(false);
  });
});
