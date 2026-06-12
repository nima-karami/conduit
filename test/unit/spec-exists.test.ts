import { describe, expect, it } from 'vitest';
import { batchSpecExists, buildSpecSet, cardHasSpec } from '../../src/spec-exists';

describe('buildSpecSet', () => {
  it('builds an empty set from an empty array', () => {
    expect(buildSpecSet([]).size).toBe(0);
  });

  it('contains the stems it was given', () => {
    const s = buildSpecSet(['card-1', 'card-2', 'feat-login']);
    expect(s.has('card-1')).toBe(true);
    expect(s.has('card-2')).toBe(true);
    expect(s.has('feat-login')).toBe(true);
    expect(s.has('card-99')).toBe(false);
  });

  it('is case-sensitive (stems from the host are already sanitized)', () => {
    const s = buildSpecSet(['Card-1']);
    expect(s.has('Card-1')).toBe(true);
    expect(s.has('card-1')).toBe(false);
  });
});

describe('cardHasSpec', () => {
  it('returns false when the set is empty', () => {
    expect(cardHasSpec('card-1', new Set())).toBe(false);
  });

  it('returns true for a plain matching id', () => {
    const s = buildSpecSet(['card-1', 'login-flow']);
    expect(cardHasSpec('card-1', s)).toBe(true);
    expect(cardHasSpec('login-flow', s)).toBe(true);
  });

  it('returns false for an id not in the set', () => {
    const s = buildSpecSet(['card-1']);
    expect(cardHasSpec('card-99', s)).toBe(false);
  });

  it('sanitizes the card id before lookup (hostile id still matches its safe stem)', () => {
    // safeSpecFileName('../../etc/passwd') → 'passwd'
    const s = buildSpecSet(['passwd']);
    expect(cardHasSpec('../../etc/passwd', s)).toBe(true);
  });

  it('sanitizes unusual characters', () => {
    // safeSpecFileName('weird id!') → 'weird_id_'
    const s = buildSpecSet(['weird_id_']);
    expect(cardHasSpec('weird id!', s)).toBe(true);
  });

  it('a sanitized id matches itself (idempotent)', () => {
    const s = buildSpecSet(['card-1']);
    expect(cardHasSpec('card-1', s)).toBe(true);
  });
});

describe('batchSpecExists', () => {
  it('returns an empty map for no card ids', () => {
    const s = buildSpecSet(['card-1']);
    const m = batchSpecExists([], s);
    expect(m.size).toBe(0);
  });

  it('maps each card id to its has-spec result', () => {
    const s = buildSpecSet(['card-1', 'card-3']);
    const m = batchSpecExists(['card-1', 'card-2', 'card-3'], s);
    expect(m.get('card-1')).toBe(true);
    expect(m.get('card-2')).toBe(false);
    expect(m.get('card-3')).toBe(true);
  });

  it('handles sanitized ids correctly', () => {
    const s = buildSpecSet(['weird_id_']);
    const m = batchSpecExists(['weird id!', 'normal-id'], s);
    expect(m.get('weird id!')).toBe(true);
    expect(m.get('normal-id')).toBe(false);
  });

  it('preserves the original id as the map key (not the sanitized form)', () => {
    const s = buildSpecSet(['weird_id_']);
    const m = batchSpecExists(['weird id!'], s);
    expect(m.has('weird id!')).toBe(true);
    expect(m.has('weird_id_')).toBe(false);
  });
});
