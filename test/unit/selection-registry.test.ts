import { describe, expect, it, vi } from 'vitest';
import { registerSelection, selectionInActiveDoc } from '../../webview/selection-registry';

const docs = [
  { id: 'file:/a.ts', path: '/a.ts' },
  { id: 'file:/b.ts', path: '/b.ts' },
];

describe('selectionInActiveDoc — routes the active tab to its registered selection', () => {
  it('returns the selected text of the active doc', () => {
    const off = registerSelection('/b.ts', { getSelectedText: () => 'needle' });
    expect(selectionInActiveDoc(docs, 'file:/b.ts')).toBe('needle');
    off();
  });

  it('reads the selection at call time, not at registration time', () => {
    let current = 'first';
    const off = registerSelection('/a.ts', { getSelectedText: () => current });
    expect(selectionInActiveDoc(docs, 'file:/a.ts')).toBe('first');
    current = 'second';
    expect(selectionInActiveDoc(docs, 'file:/a.ts')).toBe('second');
    off();
  });

  it('returns empty when the Terminal tab is active (null id)', () => {
    const off = registerSelection('/a.ts', { getSelectedText: () => 'needle' });
    expect(selectionInActiveDoc(docs, null)).toBe('');
    off();
  });

  it('returns empty when the active doc registered nothing', () => {
    expect(selectionInActiveDoc(docs, 'file:/a.ts')).toBe('');
  });

  it('returns empty when the active id matches no open doc', () => {
    const off = registerSelection('/a.ts', { getSelectedText: () => 'needle' });
    expect(selectionInActiveDoc(docs, 'file:/gone.ts')).toBe('');
    off();
  });

  it('returns empty for an empty doc list', () => {
    expect(selectionInActiveDoc([], 'file:/a.ts')).toBe('');
  });
});

describe('selection-registry — register / unregister', () => {
  it('unregisters the entry it registered', () => {
    const off = registerSelection('/a.ts', { getSelectedText: () => 'needle' });
    off();
    expect(selectionInActiveDoc(docs, 'file:/a.ts')).toBe('');
  });

  it('identity-checks the unregister so a remount keeps the live entry', () => {
    const stale = { getSelectedText: vi.fn(() => 'stale') };
    const offStale = registerSelection('/a.ts', stale);
    const offLive = registerSelection('/a.ts', { getSelectedText: () => 'live' });
    offStale();
    expect(selectionInActiveDoc(docs, 'file:/a.ts')).toBe('live');
    expect(stale.getSelectedText).not.toHaveBeenCalled();
    offLive();
  });
});
