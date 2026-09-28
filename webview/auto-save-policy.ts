import type { WriteConflict } from '../src/path-guard';
import type { AutoSaveMode } from '../src/settings';

/**
 * The per-file auto-save state machine (docs/specs/2026-09-28-auto-save.md §2.3) as a pure
 * reducer. Timers, writes and toasts are effects the caller runs; the transition table lives in
 * docs/plans/2026-09-28-auto-save.plan.md (Contracts → Policy).
 */

export type AutoSavePhase = 'clean' | 'dirty' | 'saving' | 'failed' | 'conflict';
export type AutoSaveTrigger = 'timer' | 'editorBlur' | 'viewLeave' | 'windowBlur';
export type SaveKind = 'auto' | 'manual' | 'force';

export interface AutoSaveState {
  phase: AutoSavePhase;
  /** A user edit made the buffer dirty since attach / the last successful save (C10). */
  edited: boolean;
  /** Trailing request raised while `saving`; strongest wins: force > manual > auto. */
  pending: SaveKind | null;
  conflict: WriteConflict | null;
  /** A failure was already reported since the last success (D10). */
  failStreak: boolean;
}

export const INITIAL_AUTO_SAVE_STATE: AutoSaveState = {
  phase: 'clean',
  edited: false,
  pending: null,
  conflict: null,
  failStreak: false,
};

export type AutoSaveEvent =
  | { type: 'edit'; dirty: boolean }
  | { type: 'trigger'; trigger: AutoSaveTrigger }
  | { type: 'request'; kind: SaveKind }
  | { type: 'writeDone'; outcome: 'ok'; dirty: boolean }
  | { type: 'writeDone'; outcome: 'failed'; kind: SaveKind }
  | { type: 'writeDone'; outcome: 'conflict'; conflict: WriteConflict }
  | { type: 'reset' }
  | { type: 'modeChanged' };

export type AutoSaveEffect =
  | { type: 'save'; kind: SaveKind }
  | { type: 'arm' }
  | { type: 'clear' }
  | { type: 'reportFailure' };

const TRIGGERS: Record<AutoSaveMode, ReadonlySet<AutoSaveTrigger>> = {
  off: new Set(),
  afterDelay: new Set(['timer', 'viewLeave', 'windowBlur']),
  onFocusChange: new Set(['editorBlur', 'viewLeave', 'windowBlur']),
  onWindowChange: new Set(['windowBlur']),
};

/** §2.2 matrix: does `trigger` save in `mode`? */
export function triggerSaves(mode: AutoSaveMode, trigger: AutoSaveTrigger): boolean {
  return TRIGGERS[mode].has(trigger);
}

const RANK: Record<SaveKind, number> = { auto: 0, manual: 1, force: 2 };
const stronger = (a: SaveKind | null, b: SaveKind): SaveKind =>
  a !== null && RANK[a] >= RANK[b] ? a : b;

type Step = { state: AutoSaveState; effects: AutoSaveEffect[] };
const none = (state: AutoSaveState): Step => ({ state, effects: [] });

export function autoSaveStep(state: AutoSaveState, event: AutoSaveEvent, mode: AutoSaveMode): Step {
  const arm: AutoSaveEffect[] = mode === 'afterDelay' ? [{ type: 'arm' }] : [];
  switch (event.type) {
    case 'edit': {
      if (state.phase === 'conflict') return none(state);
      if (state.phase === 'saving') {
        return event.dirty ? { state: { ...state, edited: true }, effects: arm } : none(state);
      }
      if (!event.dirty) {
        return { state: { ...state, phase: 'clean', edited: false }, effects: [{ type: 'clear' }] };
      }
      const phase = state.phase === 'failed' ? 'failed' : 'dirty';
      return { state: { ...state, phase, edited: true }, effects: arm };
    }
    case 'trigger': {
      if (!triggerSaves(mode, event.trigger)) return none(state);
      if (state.phase === 'saving') {
        return none({ ...state, pending: stronger(state.pending, 'auto') });
      }
      if ((state.phase === 'dirty' || state.phase === 'failed') && state.edited) {
        return {
          state: { ...state, phase: 'saving' },
          effects: [{ type: 'clear' }, { type: 'save', kind: 'auto' }],
        };
      }
      return none(state);
    }
    case 'request': {
      switch (state.phase) {
        case 'clean':
          return none(state);
        case 'saving':
          return none({ ...state, pending: stronger(state.pending, event.kind) });
        case 'conflict':
          if (event.kind !== 'force') return none(state);
          return {
            state: { ...state, phase: 'saving', conflict: null },
            effects: [{ type: 'save', kind: 'force' }],
          };
        default:
          return {
            state: { ...state, phase: 'saving' },
            effects: [{ type: 'clear' }, { type: 'save', kind: event.kind }],
          };
      }
    }
    case 'writeDone': {
      if (event.outcome === 'ok') {
        if (!event.dirty) {
          return none({
            ...state,
            phase: 'clean',
            edited: false,
            pending: null,
            failStreak: false,
          });
        }
        if (state.pending !== null) {
          return {
            state: { ...state, phase: 'saving', pending: null, failStreak: false },
            effects: [{ type: 'save', kind: state.pending }],
          };
        }
        return none({ ...state, phase: 'dirty', failStreak: false });
      }
      if (event.outcome === 'failed') {
        const report = event.kind !== 'auto' || !state.failStreak;
        return {
          state: { ...state, phase: 'failed', pending: null, failStreak: true },
          effects: report ? [{ type: 'reportFailure' }] : [],
        };
      }
      return {
        state: { ...state, phase: 'conflict', conflict: event.conflict, pending: null },
        effects: [{ type: 'clear' }],
      };
    }
    case 'reset':
      return { state: INITIAL_AUTO_SAVE_STATE, effects: [{ type: 'clear' }] };
    case 'modeChanged':
      return { state, effects: [{ type: 'clear' }] };
  }
}
