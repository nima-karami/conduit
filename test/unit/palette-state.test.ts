import { describe, expect, it } from 'vitest';
import { type PaletteBadgeTone, sessionPaletteFields } from '../../src/palette-state';
import { SESSION_STATE_WORD, type SessionIconVisualState } from '../../src/session-icon';

const STATES: SessionIconVisualState[] = ['busy', 'attention', 'review', 'idle', 'stale'];

/** Minimal sessions in each of the five states, built through the real flags. */
const dirty = { kind: 'branch', branch: 'main', dirty: true } as const;
const SAMPLE: Record<SessionIconVisualState, Parameters<typeof sessionPaletteFields>[0]> = {
  busy: { id: 's', status: 'running', busy: true },
  attention: { id: 's', status: 'running', needsAttention: true },
  review: { id: 's', status: 'running', completedRun: true, git: dirty },
  idle: { id: 's', status: 'running' },
  stale: { id: 's', status: 'exited' },
};

describe('sessionPaletteFields', () => {
  it('shows the rail’s own word for every state', () => {
    for (const state of STATES) {
      expect(sessionPaletteFields(SAMPLE[state], null).badge).toBe(SESSION_STATE_WORD[state]);
    }
  });

  it('reads state through sessionIconState, including its precedence', () => {
    // Busy outranks attention, and not-running outranks everything.
    expect(
      sessionPaletteFields({ id: 's', status: 'running', busy: true, needsAttention: true }, null)
        .badge,
    ).toBe(SESSION_STATE_WORD.busy);
    expect(
      sessionPaletteFields({ id: 's', status: 'stale', busy: true, needsAttention: true }, null)
        .badge,
    ).toBe(SESSION_STATE_WORD.stale);
  });

  it('gives the two states that want something the same warning tone, and nothing else', () => {
    const tone = (s: SessionIconVisualState): PaletteBadgeTone =>
      sessionPaletteFields(SAMPLE[s], null).badgeTone;
    expect(STATES.filter((s) => tone(s) === 'warn')).toEqual(['attention', 'review']);
    expect(tone('busy')).toBe('accent');
    expect(tone('idle')).toBe('neutral');
    expect(tone('stale')).toBe('quiet');
  });

  it('marks only the session the user is already in', () => {
    const ids = ['a', 'b', 'c'];
    for (const activeId of [...ids, null, undefined]) {
      const marked = ids.filter(
        (id) => sessionPaletteFields({ id, status: 'running' }, activeId).current,
      );
      expect(marked).toEqual(activeId == null ? [] : [activeId]);
    }
  });

  it('keeps "current" independent of state — a busy session can also be the current one', () => {
    const fields = sessionPaletteFields({ id: 'a', status: 'running', busy: true }, 'a');
    expect(fields).toEqual({ badge: SESSION_STATE_WORD.busy, badgeTone: 'accent', current: true });
  });
});
