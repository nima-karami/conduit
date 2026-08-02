import { describe, expect, it } from 'vitest';
import { sessionRowClass } from '../../src/session-dot';
import { SESSION_STATE_WORD, type SessionIconVisualState } from '../../src/session-icon';

const STATES: SessionIconVisualState[] = ['busy', 'attention', 'review', 'idle', 'stale'];

describe('SESSION_STATE_WORD', () => {
  // The card shows the session's own icon and no state dot — two glyphs on one row read as
  // clutter — so the word is now the ONLY non-colour carrier of state. It has to be complete.
  it('pairs every state with a distinct word (state is never colour alone)', () => {
    const words = STATES.map((s) => SESSION_STATE_WORD[s]);
    expect(new Set(words).size).toBe(STATES.length);
    for (const w of words) expect(w.trim()).not.toBe('');
  });

  it('is one string set for all themes — Neon uppercases in CSS, not in the copy (D14)', () => {
    // A per-theme rewrite would show up here as SHOUTING or an alternative spelling.
    expect(SESSION_STATE_WORD.attention).toBe('Needs you');
    expect(SESSION_STATE_WORD.busy).toBe('Busy');
  });
});

describe('sessionRowClass (R4.4 — selection-border exclusivity)', () => {
  const has = (cls: string, mod: string) => cls.split(' ').includes(mod);

  it('selected card carries the selection class; unselected never does', () => {
    expect(
      has(sessionRowClass({ selected: true, state: 'idle', dropTarget: false }), 'session--active'),
    ).toBe(true);
    expect(
      has(
        sessionRowClass({ selected: false, state: 'idle', dropTarget: false }),
        'session--active',
      ),
    ).toBe(false);
  });

  it('carries exactly one state class, separate from the selection class', () => {
    for (const state of STATES) {
      const cls = sessionRowClass({ selected: false, state, dropTarget: false });
      const stateMods = cls
        .split(' ')
        .filter((c) => c.startsWith('session--') && c !== 'session--active');
      expect(stateMods).toEqual([`session--${state}`]);
      expect(has(cls, 'session--active')).toBe(false);
    }
  });

  it('a both-selected-and-attention card emits both classes for the CSS override', () => {
    const both = sessionRowClass({ selected: true, state: 'attention', dropTarget: false });
    expect(has(both, 'session--active')).toBe(true);
    expect(has(both, 'session--attention')).toBe(true);
    // The `.session--active.session--attention` rule in styles.css makes selection
    // win visually; both classes must be present for that compound selector to bind.
  });

  it('always starts with the base `session` class and drops empty tokens', () => {
    const cls = sessionRowClass({ selected: false, state: 'idle', dropTarget: false });
    expect(cls).toBe('session session--idle');
    expect(cls).not.toMatch(/\s{2,}/);
  });

  it('dropTarget toggles its own marker independently of selection/state', () => {
    expect(
      has(
        sessionRowClass({ selected: false, state: 'idle', dropTarget: true }),
        'session--dropbefore',
      ),
    ).toBe(true);
  });

  it('across a session list, at most ONE card is ever --active (single source of truth)', () => {
    // Selection is derived from `id === activeId` upstream; model that here to prove
    // the row classes can never paint two selection borders at once.
    const ids = ['a', 'b', 'c', 'd'];
    for (const activeId of [...ids, undefined]) {
      const activeCount = ids.filter((id) =>
        sessionRowClass({
          selected: id === activeId,
          // Every card flagged for attention — the worst case for ambiguity.
          state: 'attention',
          dropTarget: false,
        })
          .split(' ')
          .includes('session--active'),
      ).length;
      expect(activeCount).toBe(activeId === undefined ? 0 : 1);
    }
  });
});
