import { describe, expect, it } from 'vitest';
import {
  deriveBoundaryState,
  fallbackMessage,
  initialBoundaryState,
  shouldShowFallback,
} from '../../webview/components/error-boundary-state';

describe('error-boundary logic', () => {
  it('starts healthy (no error, no fallback)', () => {
    expect(initialBoundaryState.error).toBeNull();
    expect(shouldShowFallback(initialBoundaryState)).toBe(false);
  });

  it('derives a caught state from a thrown Error and shows the fallback', () => {
    const err = new Error('boom');
    const state = deriveBoundaryState(err);
    expect(state.error).toBe(err);
    expect(shouldShowFallback(state)).toBe(true);
  });

  it('normalizes a non-Error throw to an Error', () => {
    const state = deriveBoundaryState('weird string throw');
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error?.message).toBe('weird string throw');
    expect(shouldShowFallback(state)).toBe(true);
  });

  it('handles the real WebGL teardown throw shape', () => {
    const state = deriveBoundaryState(
      new TypeError("Cannot read properties of undefined (reading '_isDisposed')"),
    );
    expect(shouldShowFallback(state)).toBe(true);
    expect(fallbackMessage(state.error)).toContain('_isDisposed');
  });

  it('fallbackMessage degrades gracefully for a null error', () => {
    expect(fallbackMessage(null)).toBe('Something went wrong.');
  });
});
