import { describe, expect, it } from 'vitest';
import { shouldRaiseOsAttention } from '../../src/os-attention';

describe('shouldRaiseOsAttention', () => {
  it('fires when enabled, on the edge, and window is unfocused', () => {
    expect(
      shouldRaiseOsAttention({ becameNeedsAttention: true, windowFocused: false, enabled: true }),
    ).toBe(true);
  });

  it('is suppressed when the window is focused (user is already looking)', () => {
    expect(
      shouldRaiseOsAttention({ becameNeedsAttention: true, windowFocused: true, enabled: true }),
    ).toBe(false);
  });

  it('is suppressed when the feature is disabled', () => {
    expect(
      shouldRaiseOsAttention({ becameNeedsAttention: true, windowFocused: false, enabled: false }),
    ).toBe(false);
  });

  it('is suppressed when it is not an edge (session was already needs-attention)', () => {
    // becameNeedsAttention=false means the flag was already set — not a fresh edge
    expect(
      shouldRaiseOsAttention({ becameNeedsAttention: false, windowFocused: false, enabled: true }),
    ).toBe(false);
  });

  it('is suppressed when disabled AND focused AND not an edge', () => {
    expect(
      shouldRaiseOsAttention({ becameNeedsAttention: false, windowFocused: true, enabled: false }),
    ).toBe(false);
  });

  it('is suppressed when disabled and unfocused on the edge', () => {
    expect(
      shouldRaiseOsAttention({ becameNeedsAttention: true, windowFocused: false, enabled: false }),
    ).toBe(false);
  });

  it('is suppressed when enabled and on the edge but window is focused', () => {
    expect(
      shouldRaiseOsAttention({ becameNeedsAttention: true, windowFocused: true, enabled: true }),
    ).toBe(false);
  });
});
