/**
 * quit-guard.ts — pure decision logic for quit/close/update-relaunch confirmation.
 *
 * Mirrors webview/close-dirty.ts: pure functions only, no React, no store imports.
 * All impure orchestration (showing the dialog, IPC, invoking close/install) is
 * done by the caller (electron/main.ts, electron/updater.ts).
 */

import type { Session } from './types';

export type QuitReason = 'quit' | 'update';

export interface QuitConfirmCopyInput {
  running: Session[];
  busy: number;
  reason: QuitReason;
}

export interface QuitConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/** Sessions with a live PTY (`status === 'running'`). */
export function runningSessions(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.status === 'running');
}

/**
 * Running sessions that are currently flagged busy/actively working.
 * Consumed as-is — this spec does not change busy detection.
 */
export function busySessions(sessions: Session[]): Session[] {
  return runningSessions(sessions).filter((s) => !!s.busy);
}

/**
 * True when quitting/closing requires confirmation (≥1 live PTY session).
 * False-negatives cost agent work; false-positives cost one keypress.
 */
export function needsQuitConfirm(sessions: Session[]): boolean {
  return runningSessions(sessions).length > 0;
}

/**
 * Build the dialog copy for the quit/close/update confirmation.
 *
 * - Quit/close: title "N session(s) still running", body "Quitting will stop them …",
 *   destructive button "Quit".
 * - Update: same body but destructive button "Relaunch & update".
 * - When busy === 0 the "(M actively working)" clause is omitted.
 * - Singular/plural handled throughout.
 */
export function quitConfirmCopy({ running, busy, reason }: QuitConfirmCopyInput): QuitConfirmCopy {
  const n = running.length;
  const sessionWord = n === 1 ? 'session' : 'sessions';
  const title = `${n} ${sessionWord} still running`;

  const busyClause = busy > 0 ? ` (${busy} actively working)` : '';
  const body =
    reason === 'update'
      ? `This closes ${n} running agent${n === 1 ? '' : 's'}${busyClause}. They'll be restored as stale on relaunch.`
      : `Quitting will stop ${n} running agent${n === 1 ? '' : 's'}${busyClause}.`;

  const confirmLabel = reason === 'update' ? 'Relaunch & update' : 'Quit';

  return { title, body, confirmLabel };
}
