import { describe, expect, it } from 'vitest';
import { dotClass, dotState, dotTitle, sessionRowClass } from '../../src/session-dot';
import type { Session } from '../../src/types';

const sess = (over: Partial<Session>): Session => ({
  id: 's1',
  name: 'S1',
  agentId: 'a1',
  projectPath: '/p',
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});

describe('dotState', () => {
  it('running + quiet -> a single vibrant running dot', () => {
    expect(dotState(sess({ status: 'running' }))).toEqual({
      tone: 'running',
      vibrant: true,
      pulse: false,
    });
  });

  it('running + busy -> a single vibrant pulsing busy dot', () => {
    expect(dotState(sess({ status: 'running', busy: true }))).toEqual({
      tone: 'busy',
      vibrant: true,
      pulse: true,
    });
  });

  it('running + needsAttention -> a single vibrant attention dot', () => {
    expect(dotState(sess({ status: 'running', needsAttention: true }))).toEqual({
      tone: 'attention',
      vibrant: true,
      pulse: false,
    });
  });

  it('needsAttention outranks busy (attention wins) — still ONE dot', () => {
    expect(dotState(sess({ status: 'running', busy: true, needsAttention: true })).tone).toBe(
      'attention',
    );
  });

  it('exited -> off (dimmed), regardless of stale runtime flags', () => {
    expect(dotState(sess({ status: 'exited' }))).toEqual({
      tone: 'off',
      vibrant: false,
      pulse: false,
    });
    // A leftover busy/attention flag on a dead session must NOT light the dot.
    expect(dotState(sess({ status: 'exited', busy: true, needsAttention: true })).vibrant).toBe(
      false,
    );
  });

  it('stale -> off (dimmed)', () => {
    expect(dotState(sess({ status: 'stale' })).tone).toBe('off');
    expect(dotState(sess({ status: 'stale', busy: true })).vibrant).toBe(false);
  });

  it('every status produces exactly one well-formed dot (never two)', () => {
    for (const status of ['running', 'exited', 'stale'] as const) {
      for (const busy of [false, true]) {
        for (const needsAttention of [false, true]) {
          const st = dotState(sess({ status, busy, needsAttention }));
          // A single tone string is always returned — one dot, never a pair.
          expect(['attention', 'busy', 'running', 'off']).toContain(st.tone);
          // vibrant iff the session is active (running, in any activity sub-state).
          expect(st.vibrant).toBe(status === 'running');
        }
      }
    }
  });
});

describe('dotClass', () => {
  it('renders a single `.dot` plus exactly one tone modifier', () => {
    expect(dotClass(dotState(sess({ status: 'running' })))).toBe('dot dot--running');
    expect(dotClass(dotState(sess({ status: 'exited' })))).toBe('dot dot--off');
    expect(dotClass(dotState(sess({ status: 'running', needsAttention: true })))).toBe(
      'dot dot--attention',
    );
  });

  it('adds the pulse modifier only when busy', () => {
    expect(dotClass(dotState(sess({ status: 'running', busy: true })))).toBe(
      'dot dot--busy dot--pulse',
    );
    expect(dotClass(dotState(sess({ status: 'running' })))).not.toContain('dot--pulse');
  });
});

describe('dotTitle', () => {
  it('gives a hover label for active tones and none when off', () => {
    expect(dotTitle(dotState(sess({ status: 'running', needsAttention: true })))).toBe(
      'Finished — needs attention',
    );
    expect(dotTitle(dotState(sess({ status: 'running', busy: true })))).toBe('Busy');
    expect(dotTitle(dotState(sess({ status: 'running' })))).toBe('Running');
    expect(dotTitle(dotState(sess({ status: 'exited' })))).toBeUndefined();
  });
});

describe('sessionRowClass (R4.4 — selection-border exclusivity)', () => {
  const has = (cls: string, mod: string) => cls.split(' ').includes(mod);

  it('selected card carries the selection class; unselected never does', () => {
    expect(
      has(
        sessionRowClass({ selected: true, needsAttention: false, dropTarget: false }),
        'session--active',
      ),
    ).toBe(true);
    expect(
      has(
        sessionRowClass({ selected: false, needsAttention: false, dropTarget: false }),
        'session--active',
      ),
    ).toBe(false);
  });

  it('attention is a SEPARATE class from selection (distinct cues)', () => {
    const attnOnly = sessionRowClass({ selected: false, needsAttention: true, dropTarget: false });
    // Attention present, selection absent — the amber attention bar, not the accent
    // selection bar, so an attention card is never mistaken for the selected one.
    expect(has(attnOnly, 'session--attention')).toBe(true);
    expect(has(attnOnly, 'session--active')).toBe(false);
  });

  it('a both-selected-and-attention card emits both classes for the CSS override', () => {
    const both = sessionRowClass({ selected: true, needsAttention: true, dropTarget: false });
    expect(has(both, 'session--active')).toBe(true);
    expect(has(both, 'session--attention')).toBe(true);
    // The `.session--active.session--attention` rule in styles.css makes selection
    // win visually; both classes must be present for that compound selector to bind.
  });

  it('always starts with the base `session` class and drops empty tokens', () => {
    const cls = sessionRowClass({ selected: false, needsAttention: false, dropTarget: false });
    expect(cls).toBe('session');
    // No stray empty segments (the old template-string form left double spaces).
    expect(cls).not.toMatch(/\s{2,}/);
  });

  it('dropTarget toggles its own marker independently of selection/attention', () => {
    expect(
      has(
        sessionRowClass({ selected: false, needsAttention: false, dropTarget: true }),
        'session--dropbefore',
      ),
    ).toBe(true);
  });

  it('across a session list, at most ONE card is ever --active (single source of truth)', () => {
    // Selection is derived from `id === activeId` upstream; model that here to prove
    // the row classes can never paint two selection borders at once.
    const ids = ['a', 'b', 'c', 'd'];
    for (const activeId of [...ids, undefined]) {
      const activeCount = ids.filter((id) => {
        const cls = sessionRowClass({
          selected: id === activeId,
          // Every card flagged for attention — the worst case for ambiguity.
          needsAttention: true,
          dropTarget: false,
        });
        return cls.split(' ').includes('session--active');
      }).length;
      // Exactly one when an id is active; zero when nothing is selected. Never two.
      expect(activeCount).toBe(activeId === undefined ? 0 : 1);
    }
  });
});
