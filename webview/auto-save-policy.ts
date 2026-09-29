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
  /** attach's dirty computation: a seed that differs from disk (C10) is dirty but never an edit. */
  | { type: 'seed'; dirty: boolean }
  | { type: 'trigger'; trigger: AutoSaveTrigger }
  | { type: 'request'; kind: SaveKind }
  | { type: 'writeDone'; outcome: 'ok'; dirty: boolean }
  | { type: 'writeDone'; outcome: 'failed'; kind: SaveKind }
  | { type: 'writeDone'; outcome: 'conflict'; conflict: WriteConflict }
  | { type: 'reset' }
  | { type: 'modeChanged' }
  /** The file was deleted or replaced under the buffer by an explorer action: the same pause as
   *  a write that found it so, and nothing is written until the user picks. */
  | { type: 'diskConflict'; conflict: WriteConflict };

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
export const stronger = (a: SaveKind | null, b: SaveKind): SaveKind =>
  a !== null && RANK[a] >= RANK[b] ? a : b;

type Step = { state: AutoSaveState; effects: AutoSaveEffect[] };
const none = (state: AutoSaveState): Step => ({ state, effects: [] });

export function autoSaveStep(state: AutoSaveState, event: AutoSaveEvent, mode: AutoSaveMode): Step {
  const arm: AutoSaveEffect[] = mode === 'afterDelay' ? [{ type: 'arm' }] : [];
  switch (event.type) {
    case 'seed': {
      if (state.phase === 'saving' || state.phase === 'conflict') return none(state);
      if (!event.dirty) {
        return { state: { ...state, phase: 'clean', edited: false }, effects: [{ type: 'clear' }] };
      }
      return none(state.phase === 'clean' ? { ...state, phase: 'dirty', edited: false } : state);
    }
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
          // An auto save needs a user edit, like a trigger: a buffer that differs from disk only
          // by the seed (C10) would otherwise be rewritten by a close.
          if (event.kind === 'auto' && !state.edited) return none(state);
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
    case 'diskConflict':
      return {
        state: { ...state, phase: 'conflict', conflict: event.conflict, pending: null },
        effects: [{ type: 'clear' }],
      };
    case 'reset':
      return { state: INITIAL_AUTO_SAVE_STATE, effects: [{ type: 'clear' }] };
    case 'modeChanged':
      return { state, effects: [{ type: 'clear' }] };
  }
}

/** The save-status fields the close decisions read. */
interface CloseStatus {
  phase: AutoSavePhase;
  edited: boolean;
  error: string | null;
}

export type CloseStep =
  | { type: 'prompt'; reason: string | null }
  | { type: 'close' }
  | { type: 'save' };

/** What closing a dirty file tab does first (D2). With auto save on, a buffer that differs from
 *  disk only by the seed (C10) closes without a write or a prompt; with it off, it still prompts. */
export function dirtyCloseStep(
  mode: AutoSaveMode,
  status: CloseStatus | undefined,
  hasEntry: boolean,
): CloseStep {
  if (mode === 'off' || !hasEntry) return { type: 'prompt', reason: null };
  if (status?.phase === 'dirty' && !status.edited) return { type: 'close' };
  return { type: 'save' };
}

/** After the close's own save: close only if nothing was typed during it; otherwise prompt,
 *  naming the reason only when the save actually failed or conflicted. */
export function afterCloseSave(
  ok: boolean,
  stillDirty: boolean,
  status: CloseStatus | undefined,
): CloseStep {
  if (ok && !stillDirty) return { type: 'close' };
  const failed = !ok && (status?.phase === 'failed' || status?.phase === 'conflict');
  return { type: 'prompt', reason: failed ? (status?.error ?? null) : null };
}
