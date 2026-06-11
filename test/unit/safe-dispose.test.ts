import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeTerminal, safeDispose } from '../../webview/components/safe-dispose';

describe('safe-dispose', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns false for null / undefined / non-disposable', () => {
    expect(safeDispose(null)).toBe(false);
    expect(safeDispose(undefined)).toBe(false);
    expect(safeDispose({} as never)).toBe(false);
  });

  it('runs dispose and returns true when it succeeds', () => {
    const dispose = vi.fn();
    expect(safeDispose({ dispose })).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('swallows a throwing dispose (does not rethrow) and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = () => {
      // Mirrors the real WebGL teardown crash: `_isDisposed` of undefined.
      throw new TypeError("Cannot read properties of undefined (reading '_isDisposed')");
    };
    expect(() => safeDispose({ dispose: boom }, 'webgl')).not.toThrow();
    expect(safeDispose({ dispose: boom })).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('disposeTerminal tears down addons before the terminal, each guarded', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const webgl = {
      dispose: () => {
        order.push('webgl');
        throw new Error('webgl boom'); // must not abort the rest
      },
    };
    const fit = { dispose: () => order.push('fit') };
    const term = { dispose: () => order.push('term') };

    expect(() => disposeTerminal(term, [webgl, fit])).not.toThrow();
    // Addons first (in order given), terminal last; a throwing addon doesn't skip the rest.
    expect(order).toEqual(['webgl', 'fit', 'term']);
  });

  it('disposeTerminal tolerates null entries and a null terminal', () => {
    expect(() => disposeTerminal(null, [null, undefined])).not.toThrow();
  });
});
