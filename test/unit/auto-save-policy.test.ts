import { describe, expect, it } from 'vitest';
import type { AutoSaveMode } from '../../src/settings';
import {
  type AutoSaveEffect,
  type AutoSaveEvent,
  type AutoSaveState,
  type AutoSaveTrigger,
  afterCloseSave,
  autoSaveStep,
  dirtyCloseStep,
  INITIAL_AUTO_SAVE_STATE,
  triggerSaves,
} from '../../webview/auto-save-policy';

const at = (over: Partial<AutoSaveState>): AutoSaveState => ({
  ...INITIAL_AUTO_SAVE_STATE,
  ...over,
});
const step = (s: AutoSaveState, e: AutoSaveEvent, mode: AutoSaveMode = 'afterDelay') =>
  autoSaveStep(s, e, mode);
const ARM: AutoSaveEffect = { type: 'arm' };
const CLEAR: AutoSaveEffect = { type: 'clear' };

describe('auto-save policy transition table', () => {
  for (const phase of ['clean', 'dirty', 'failed'] as const) {
    it(`${phase} + edit dirty → dirty-ish, edited, arms only in afterDelay`, () => {
      const r = step(at({ phase }), { type: 'edit', dirty: true });
      expect(r.state.phase).toBe(phase === 'failed' ? 'failed' : 'dirty');
      expect(r.state.edited).toBe(true);
      expect(r.effects).toEqual([ARM]);
      expect(step(at({ phase }), { type: 'edit', dirty: true }, 'onFocusChange').effects).toEqual(
        [],
      );
    });

    it(`${phase} + edit clean → clean, not edited, clears the timer`, () => {
      const r = step(at({ phase, edited: true }), { type: 'edit', dirty: false });
      expect(r.state).toMatchObject({ phase: 'clean', edited: false });
      expect(r.effects).toEqual([CLEAR]);
    });
  }

  it('saving + edit dirty keeps saving, marks edited, arms in afterDelay', () => {
    const r = step(at({ phase: 'saving' }), { type: 'edit', dirty: true });
    expect(r.state).toMatchObject({ phase: 'saving', edited: true });
    expect(r.effects).toEqual([ARM]);
    expect(step(at({ phase: 'saving' }), { type: 'edit', dirty: true }, 'off').effects).toEqual([]);
  });

  it('saving + edit clean is unchanged with no effect', () => {
    const s = at({ phase: 'saving', edited: true });
    expect(step(s, { type: 'edit', dirty: false })).toEqual({ state: s, effects: [] });
  });

  it('conflict + edit is unchanged with no effect', () => {
    const s = at({ phase: 'conflict', conflict: 'changed' });
    expect(step(s, { type: 'edit', dirty: true })).toEqual({ state: s, effects: [] });
    expect(step(s, { type: 'edit', dirty: false })).toEqual({ state: s, effects: [] });
  });

  for (const phase of ['dirty', 'failed'] as const) {
    it(`${phase} + edited + saving trigger → saving, clear, save auto`, () => {
      const r = step(at({ phase, edited: true }), { type: 'trigger', trigger: 'timer' });
      expect(r.state.phase).toBe('saving');
      expect(r.effects).toEqual([CLEAR, { type: 'save', kind: 'auto' }]);
    });

    it(`${phase} + not edited + trigger is unchanged`, () => {
      const s = at({ phase, edited: false });
      expect(step(s, { type: 'trigger', trigger: 'timer' })).toEqual({ state: s, effects: [] });
    });
  }

  it('dirty + trigger the mode does not save is unchanged', () => {
    const s = at({ phase: 'dirty', edited: true });
    expect(step(s, { type: 'trigger', trigger: 'editorBlur' })).toEqual({ state: s, effects: [] });
  });

  it('saving + trigger raises pending auto without an effect', () => {
    const r = step(at({ phase: 'saving' }), { type: 'trigger', trigger: 'viewLeave' });
    expect(r.state.pending).toBe('auto');
    expect(r.effects).toEqual([]);
    const kept = step(at({ phase: 'saving', pending: 'manual' }), {
      type: 'trigger',
      trigger: 'timer',
    });
    expect(kept.state.pending).toBe('manual');
  });

  for (const phase of ['clean', 'conflict'] as const) {
    it(`${phase} + trigger is unchanged`, () => {
      const s = at({ phase, edited: true });
      expect(step(s, { type: 'trigger', trigger: 'windowBlur' })).toEqual({
        state: s,
        effects: [],
      });
    });
  }

  it('clean + request is unchanged with no effect', () => {
    const s = at({ phase: 'clean' });
    expect(step(s, { type: 'request', kind: 'manual' })).toEqual({ state: s, effects: [] });
  });

  for (const phase of ['dirty', 'failed'] as const) {
    it(`${phase} + request k → saving, clear, save k (ignores mode and edited)`, () => {
      const r = step(at({ phase }), { type: 'request', kind: 'manual' }, 'off');
      expect(r.state.phase).toBe('saving');
      expect(r.effects).toEqual([CLEAR, { type: 'save', kind: 'manual' }]);
    });
  }

  it('dirty + not edited + request auto → no write (a seed difference is never auto-saved)', () => {
    const s = at({ phase: 'dirty', edited: false });
    expect(step(s, { type: 'request', kind: 'auto' })).toEqual({ state: s, effects: [] });
    expect(step(s, { type: 'request', kind: 'manual' }).effects).toEqual([
      CLEAR,
      { type: 'save', kind: 'manual' },
    ]);
    expect(step(s, { type: 'request', kind: 'force' }).effects).toEqual([
      CLEAR,
      { type: 'save', kind: 'force' },
    ]);
  });

  it('saving + request raises pending to the strongest kind', () => {
    let s = at({ phase: 'saving' });
    s = step(s, { type: 'request', kind: 'auto' }).state;
    expect(s.pending).toBe('auto');
    s = step(s, { type: 'request', kind: 'force' }).state;
    expect(s.pending).toBe('force');
    const r = step(s, { type: 'request', kind: 'manual' });
    expect(r.state.pending).toBe('force');
    expect(r.effects).toEqual([]);
  });

  it('conflict + request manual or auto is unchanged', () => {
    const s = at({ phase: 'conflict', conflict: 'changed' });
    expect(step(s, { type: 'request', kind: 'manual' })).toEqual({ state: s, effects: [] });
    expect(step(s, { type: 'request', kind: 'auto' })).toEqual({ state: s, effects: [] });
  });

  it('conflict + request force → saving, conflict cleared, save force', () => {
    const r = step(at({ phase: 'conflict', conflict: 'deleted' }), {
      type: 'request',
      kind: 'force',
    });
    expect(r.state).toMatchObject({ phase: 'saving', conflict: null });
    expect(r.effects).toEqual([{ type: 'save', kind: 'force' }]);
  });

  it('saving + writeDone ok clean → clean, resets edited/pending/failStreak', () => {
    const r = step(at({ phase: 'saving', edited: true, pending: 'auto', failStreak: true }), {
      type: 'writeDone',
      outcome: 'ok',
      dirty: false,
    });
    expect(r.state).toEqual(INITIAL_AUTO_SAVE_STATE);
    expect(r.effects).toEqual([]);
  });

  it('saving + writeDone ok dirty with pending → one trailing save of that kind', () => {
    const r = step(at({ phase: 'saving', pending: 'manual', failStreak: true }), {
      type: 'writeDone',
      outcome: 'ok',
      dirty: true,
    });
    expect(r.state).toMatchObject({ phase: 'saving', pending: null, failStreak: false });
    expect(r.effects).toEqual([{ type: 'save', kind: 'manual' }]);
  });

  it('saving + writeDone ok dirty without pending → dirty', () => {
    const r = step(at({ phase: 'saving', edited: true, failStreak: true }), {
      type: 'writeDone',
      outcome: 'ok',
      dirty: true,
    });
    expect(r.state).toMatchObject({ phase: 'dirty', edited: true, failStreak: false });
    expect(r.effects).toEqual([]);
  });

  it('saving + writeDone failed → failed, reports the first of a streak', () => {
    const r = step(at({ phase: 'saving', pending: 'auto' }), {
      type: 'writeDone',
      outcome: 'failed',
      kind: 'auto',
    });
    expect(r.state).toMatchObject({ phase: 'failed', pending: null, failStreak: true });
    expect(r.effects).toEqual([{ type: 'reportFailure' }]);
  });

  it('saving + writeDone conflict → conflict, clears the timer', () => {
    const r = step(at({ phase: 'saving', pending: 'auto' }), {
      type: 'writeDone',
      outcome: 'conflict',
      conflict: 'changed',
    });
    expect(r.state).toMatchObject({ phase: 'conflict', conflict: 'changed', pending: null });
    expect(r.effects).toEqual([CLEAR]);
  });

  for (const phase of ['clean', 'dirty', 'failed', 'saving'] as const) {
    for (const conflict of ['deleted', 'changed'] as const) {
      it(`${phase} + diskConflict ${conflict} → that conflict, keeps the edit, clears the timer`, () => {
        const r = step(at({ phase, edited: true, pending: 'auto' }), {
          type: 'diskConflict',
          conflict,
        });
        expect(r.state).toMatchObject({ phase: 'conflict', conflict, edited: true, pending: null });
        expect(r.effects).toEqual([CLEAR]);
      });
    }
  }

  it('reset → initial state, clears the timer', () => {
    const r = step(at({ phase: 'conflict', conflict: 'changed', edited: true }), { type: 'reset' });
    expect(r).toEqual({ state: INITIAL_AUTO_SAVE_STATE, effects: [CLEAR] });
  });

  it('clean + seed dirty → dirty but not edited, so triggers still skip it', () => {
    const r = step(at({ phase: 'clean' }), { type: 'seed', dirty: true });
    expect(r.state).toMatchObject({ phase: 'dirty', edited: false });
    expect(r.effects).toEqual([]);
    expect(step(r.state, { type: 'trigger', trigger: 'timer' }).effects).toEqual([]);
    expect(step(r.state, { type: 'request', kind: 'manual' }).effects).toEqual([
      CLEAR,
      { type: 'save', kind: 'manual' },
    ]);
  });

  it('dirty + seed dirty keeps an existing edit', () => {
    const r = step(at({ phase: 'dirty', edited: true }), { type: 'seed', dirty: true });
    expect(r.state).toMatchObject({ phase: 'dirty', edited: true });
  });

  it('seed clean → clean, not edited, clears the timer', () => {
    const r = step(at({ phase: 'dirty', edited: true }), { type: 'seed', dirty: false });
    expect(r.state).toMatchObject({ phase: 'clean', edited: false });
    expect(r.effects).toEqual([CLEAR]);
  });

  for (const phase of ['saving', 'conflict'] as const) {
    it(`${phase} + seed is unchanged`, () => {
      const s = at({ phase, edited: true });
      expect(step(s, { type: 'seed', dirty: false })).toEqual({ state: s, effects: [] });
    });
  }

  it('modeChanged keeps state and clears the timer', () => {
    const s = at({ phase: 'dirty', edited: true });
    expect(step(s, { type: 'modeChanged' })).toEqual({ state: s, effects: [CLEAR] });
  });
});

describe('auto-save policy behaviour', () => {
  it('triggerSaves matrix', () => {
    const triggers: AutoSaveTrigger[] = ['timer', 'editorBlur', 'viewLeave', 'windowBlur'];
    const expected: Record<AutoSaveMode, AutoSaveTrigger[]> = {
      off: [],
      afterDelay: ['timer', 'viewLeave', 'windowBlur'],
      onFocusChange: ['editorBlur', 'viewLeave', 'windowBlur'],
      onWindowChange: ['windowBlur'],
    };
    for (const [mode, yes] of Object.entries(expected) as [AutoSaveMode, AutoSaveTrigger[]][]) {
      for (const t of triggers) expect(triggerSaves(mode, t), `${mode}/${t}`).toBe(yes.includes(t));
    }
  });

  it('burst of three triggers yields one save effect', () => {
    let s = at({ phase: 'dirty', edited: true });
    const effects: AutoSaveEffect[] = [];
    for (const trigger of ['viewLeave', 'windowBlur', 'timer'] as const) {
      const r = step(s, { type: 'trigger', trigger });
      s = r.state;
      effects.push(...r.effects);
    }
    expect(effects.filter((e) => e.type === 'save')).toHaveLength(1);
  });

  it('failed auto does not re-arm', () => {
    const r = step(at({ phase: 'saving' }), { type: 'writeDone', outcome: 'failed', kind: 'auto' });
    expect(r.effects.some((e) => e.type === 'arm' || e.type === 'save')).toBe(false);
  });

  it('second consecutive auto failure does not report', () => {
    const first = step(at({ phase: 'saving' }), {
      type: 'writeDone',
      outcome: 'failed',
      kind: 'auto',
    });
    const retry = step(first.state, { type: 'trigger', trigger: 'viewLeave' });
    expect(retry.state.phase).toBe('failed');
    const edited = step(first.state, { type: 'edit', dirty: true });
    const saving = step(edited.state, { type: 'trigger', trigger: 'timer' });
    const second = step(saving.state, { type: 'writeDone', outcome: 'failed', kind: 'auto' });
    expect(second.effects).toEqual([]);
  });

  it('manual failure always reports', () => {
    const s = at({ phase: 'saving', failStreak: true });
    expect(step(s, { type: 'writeDone', outcome: 'failed', kind: 'manual' }).effects).toEqual([
      { type: 'reportFailure' },
    ]);
  });

  it('conflict suspends', () => {
    const s = at({ phase: 'conflict', conflict: 'changed', edited: true });
    for (const e of [
      { type: 'edit', dirty: true },
      { type: 'trigger', trigger: 'windowBlur' },
      { type: 'request', kind: 'manual' },
    ] as AutoSaveEvent[]) {
      expect(step(s, e).effects).toEqual([]);
    }
  });
});

describe('closing a dirty tab (D2)', () => {
  const st = (phase: AutoSaveState['phase'], edited: boolean, error: string | null = null) => ({
    phase,
    edited,
    error,
  });

  it('off, or no save entry, prompts plainly', () => {
    expect(dirtyCloseStep('off', st('dirty', true), true)).toEqual({
      type: 'prompt',
      reason: null,
    });
    expect(dirtyCloseStep('afterDelay', st('dirty', true), false)).toEqual({
      type: 'prompt',
      reason: null,
    });
  });

  it('an unedited seed-dirty buffer closes without writing or prompting', () => {
    expect(dirtyCloseStep('onFocusChange', st('dirty', false), true)).toEqual({ type: 'close' });
  });

  it('an edited buffer saves first', () => {
    expect(dirtyCloseStep('onFocusChange', st('dirty', true), true)).toEqual({ type: 'save' });
    expect(dirtyCloseStep('afterDelay', st('conflict', true), true)).toEqual({ type: 'save' });
  });

  it('closes after a save only if nothing was typed during it (F3)', () => {
    expect(afterCloseSave(true, false, st('clean', false))).toEqual({ type: 'close' });
    expect(afterCloseSave(true, true, st('dirty', true))).toEqual({ type: 'prompt', reason: null });
  });

  it('a failed or conflicted save prompts with its reason', () => {
    expect(afterCloseSave(false, true, st('failed', true, 'EACCES'))).toEqual({
      type: 'prompt',
      reason: 'EACCES',
    });
    expect(afterCloseSave(false, true, st('conflict', true, 'changed'))).toEqual({
      type: 'prompt',
      reason: 'changed',
    });
  });

  it('a refused save that wrote nothing (truncated, no host) prompts plainly', () => {
    expect(afterCloseSave(false, true, st('dirty', true))).toEqual({
      type: 'prompt',
      reason: null,
    });
    expect(afterCloseSave(false, true, undefined)).toEqual({ type: 'prompt', reason: null });
  });
});
