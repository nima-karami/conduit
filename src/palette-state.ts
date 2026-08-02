import {
  SESSION_STATE_WORD,
  type SessionIconVisualState,
  type SessionStateFields,
  sessionIconState,
} from './session-icon';

/**
 * How a palette badge reads. A tone rather than a state name, because the palette lists
 * several kinds of thing and each kind maps its own vocabulary onto these four:
 * accent = working, warn = wants something, neutral = fine, quiet = not live.
 */
export type PaletteBadgeTone = 'accent' | 'warn' | 'neutral' | 'quiet';

/** The state affordance for one palette row. */
export interface PaletteStateFields {
  badge: string;
  badgeTone: PaletteBadgeTone;
  current: boolean;
}

const TONE_BY_SESSION_STATE: Record<SessionIconVisualState, PaletteBadgeTone> = {
  busy: 'accent',
  attention: 'warn',
  review: 'warn',
  idle: 'neutral',
  stale: 'quiet',
};

/**
 * The state a session row shows in the omni-search. With the Sessions panel hidden the
 * palette is the only way to move between sessions, so a row that carries no state leaves
 * the user switching blind — including into the session they are already in.
 *
 * Derives nothing of its own: `sessionIconState()` is the single derivation (the rail and
 * the topbar chip read it too) and `SESSION_STATE_WORD` is the single set of words, so a
 * card and its palette row can never disagree. Pure.
 */
export function sessionPaletteFields(
  session: SessionStateFields & { id: string },
  activeId: string | null | undefined,
): PaletteStateFields {
  const state = sessionIconState(session);
  return {
    badge: SESSION_STATE_WORD[state],
    badgeTone: TONE_BY_SESSION_STATE[state],
    current: session.id === activeId,
  };
}
