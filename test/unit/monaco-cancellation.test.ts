import { describe, expect, it } from 'vitest';
import { isMonacoCancellation } from '../../webview/monaco-cancellation';

function named(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('isMonacoCancellation', () => {
  it("accepts Monaco's Canceled error", () => {
    expect(isMonacoCancellation(named('Canceled', 'Canceled'))).toBe(true);
  });

  it('rejects a plain Error', () => {
    expect(isMonacoCancellation(new Error('Canceled'))).toBe(false);
    expect(isMonacoCancellation(new Error('boom'))).toBe(false);
  });

  it('rejects an error that only sets the name', () => {
    expect(isMonacoCancellation(named('Canceled', 'the save failed'))).toBe(false);
  });

  it('rejects non-errors', () => {
    expect(isMonacoCancellation('Canceled')).toBe(false);
    expect(isMonacoCancellation({ name: 'Canceled', message: 'Canceled' })).toBe(false);
    expect(isMonacoCancellation(undefined)).toBe(false);
  });
});
