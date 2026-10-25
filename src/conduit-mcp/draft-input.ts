import type { ScreenVerdict } from './types';

// The renderer's term.onData carries xterm's automatic replies beside real keys; only keys are a
// human draft (spec §2 gate, "other than terminal auto-replies").
const REPLY_FORMS = {
  decrpm: '\\x1b\\[\\?[\\d;]*\\$y',
  da1: '\\x1b\\[\\?[\\d;]*c',
  da2: '\\x1b\\[>[\\d;]*c',
  cpr: '\\x1b\\[\\d+;\\d+R',
  focus: '\\x1b\\[[IO]',
  sgrMouse: '\\x1b\\[<\\d+;\\d+;\\d+[Mm]',
  x10Mouse: '\\x1b\\[M[\\s\\S]{3}',
  osc: '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
  dcs: '\\x1bP[\\s\\S]*?\\x1b\\\\',
};
const TERMINAL_REPLY = new RegExp(Object.values(REPLY_FORMS).join('|'), 'g');

export function stripTerminalReplies(data: string): string {
  return data.replace(TERMINAL_REPLY, '');
}

export function nextDraftState(hasDraft: boolean, data: string): boolean {
  const r = stripTerminalReplies(data);
  if (r === '') return hasDraft;
  const i = Math.max(r.lastIndexOf('\r'), r.lastIndexOf('\x03'));
  return i !== r.length - 1;
}

export function isCountedInput(data: string): boolean {
  return stripTerminalReplies(data) !== '';
}

/** Clears a draft the human erased or the CLI consumed unseen (plan ruling 4). */
export function settleDraft(i: {
  hasDraft: boolean;
  screen: ScreenVerdict;
  now: number;
  lastInputAt: number | undefined;
  quietMs: number;
}): boolean {
  const quiet = i.lastInputAt === undefined || i.now - i.lastInputAt >= i.quietMs;
  return i.screen === 'empty-input' && quiet ? false : i.hasDraft;
}
