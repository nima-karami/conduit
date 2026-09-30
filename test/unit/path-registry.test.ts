import { describe, expect, it } from 'vitest';
import { createPathRegistry } from '../../webview/path-registry';

describe('createPathRegistry', () => {
  it('get prefers the requested group', () => {
    const r = createPathRegistry<string>();
    r.register('/a.ts', 'left', 1);
    r.register('/a.ts', 'right', 2);
    expect(r.get('/a.ts', 1)).toBe('left');
    expect(r.get('/a.ts', 2)).toBe('right');
  });

  it('get falls back to the most recent entry', () => {
    const r = createPathRegistry<string>();
    r.register('/a.ts', 'older', 1);
    r.register('/a.ts', 'newer', 1);
    expect(r.get('/a.ts')).toBe('newer');
    expect(r.get('/a.ts', 2)).toBe('newer');
    expect(r.get('/none.ts')).toBeUndefined();
  });

  it('unregister removes only its own entry', () => {
    const r = createPathRegistry<string>();
    const offA = r.register('/a.ts', 'A', 1);
    const offB = r.register('/a.ts', 'B', 2);
    offB();
    expect(r.get('/a.ts', 2)).toBe('A');
    expect(r.entries('/a.ts')).toEqual([{ value: 'A', group: 1 }]);
    offB();
    expect(r.get('/a.ts')).toBe('A');
    offA();
    expect(r.get('/a.ts')).toBeUndefined();
    expect(r.entries('/a.ts')).toEqual([]);
  });

  it('unregister removes its own entry even when the same value registered twice', () => {
    const r = createPathRegistry<string>();
    const first = r.register('/a.ts', 'same', 1);
    r.register('/a.ts', 'same', 2);
    first();
    expect(r.entries('/a.ts')).toEqual([{ value: 'same', group: 2 }]);
  });

  it('normalize folds path spellings', () => {
    const r = createPathRegistry<string>((p) => p.replace(/\/+/g, '/').toLowerCase());
    const off = r.register('/W//a.ts', 'A', 1);
    expect(r.get('/w/a.ts')).toBe('A');
    expect(r.entries('/w/A.TS')).toEqual([{ value: 'A', group: 1 }]);
    off();
    expect(r.get('/W//a.ts')).toBeUndefined();
  });
});
