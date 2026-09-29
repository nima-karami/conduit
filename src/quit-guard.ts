/**
 * quit-guard.ts — pure decision logic for quit/close/update-relaunch confirmation.
 *
 * Mirrors webview/close-dirty.ts: pure functions only, no React, no store imports.
 * All impure orchestration (showing the dialog, IPC, invoking close/install) is
 * done by the caller (electron/main.ts, electron/updater.ts).
 */

import { countNoun } from './menu-selection';
import type { Session } from './types';

export type QuitReason = 'quit' | 'windowClose' | 'update';
export type DirtyCloseReason = QuitReason | 'sessionClose' | 'sessionMove';
export type DirtyTag = 'conflict' | 'failed' | 'notEdited' | 'noEntry' | 'partial' | 'saved' | null;

export interface DirtyFile {
  path: string;
  name: string;
  dir: string;
  tag: DirtyTag;
  error?: string;
  session?: string;
}

export interface DirtyCloseCopyInput {
  files: readonly DirtyFile[];
  running: number;
  busy: number;
  reason: DirtyCloseReason;
  exitedSession?: string;
  grouped?: boolean;
}

export interface DirtyCloseRow {
  path: string;
  name: string;
  dir: string;
  title: string;
  tag: string | null;
  danger: boolean;
  group?: string;
}

export interface DirtyCloseCopy {
  title: string;
  summary: string;
  lines: string[];
  rows: DirtyCloseRow[];
  overflow: number;
  labels: { save: string; discard: string; cancel: string; saving: string };
}

export const DIRTY_ROW_CAP = 10;

const NAME_MAX = 40;

function middleEllipsize(name: string): string {
  if (name.length <= NAME_MAX) return name;
  const room = NAME_MAX - 1;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.length - dot : 0;
  const tail = Math.min(Math.max(Math.floor(room / 2), ext), room - 1);
  return `${name.slice(0, room - tail)}…${name.slice(name.length - tail)}`;
}

const RUNNING_VERB: Record<Exclude<DirtyCloseReason, 'sessionMove'>, string> = {
  quit: 'Quitting',
  update: 'Quitting',
  windowClose: 'Closing this window',
  sessionClose: 'Closing',
};

function tagText(file: DirtyFile): { tag: string | null; danger: boolean } {
  switch (file.tag) {
    case 'conflict':
      return { tag: 'changed on disk — Save All overwrites it', danger: false };
    case 'failed':
      return { tag: `save failed: ${file.error ?? ''}`, danger: true };
    case 'notEdited':
      return { tag: 'not edited', danger: false };
    case 'noEntry':
      return { tag: "can't be saved here", danger: true };
    case 'partial':
      return { tag: "partly loaded, can't be saved", danger: true };
    case 'saved':
      return { tag: 'Saved', danger: false };
    case null:
      return { tag: null, danger: false };
  }
}

export function dirtyCloseCopy(input: DirtyCloseCopyInput): DirtyCloseCopy {
  const { files, running, busy, reason, exitedSession, grouped } = input;
  const pending = files.filter((f) => f.tag !== 'saved');
  const subject =
    pending.length === 1 ? pending[0].name : countNoun(pending.length, 'file', 'files');

  const lines: string[] = [];
  if (running > 0 && reason !== 'sessionMove') {
    const busyClause = busy > 0 ? ` (${busy} actively working)` : '';
    lines.push(
      `${RUNNING_VERB[reason]} will also stop ${countNoun(running, 'running agent', 'running agents')}${busyClause}.`,
    );
  }
  if (reason === 'update') lines.push('Conduit will relaunch to install the update.');
  if (exitedSession !== undefined) {
    lines.push(`“${exitedSession}” has exited. Closing it closes its tabs.`);
  }

  const rows = files.slice(0, DIRTY_ROW_CAP).map(
    (f): DirtyCloseRow => ({
      path: f.path,
      name: middleEllipsize(f.name),
      dir: f.dir,
      title: f.path,
      ...tagText(f),
      ...(grouped ? { group: f.session } : {}),
    }),
  );

  return {
    title: `Do you want to save the changes you made to ${subject}?`,
    summary: "Your changes will be lost if you don't save them.",
    lines,
    rows,
    overflow: Math.max(0, files.length - DIRTY_ROW_CAP),
    labels: { save: 'Save All', discard: "Don't Save", cancel: 'Cancel', saving: 'Saving…' },
  };
}

export function dirtySaveStatus(kind: 'saving' | 'failed', n: number): string {
  const files = countNoun(n, 'file', 'files');
  return kind === 'saving' ? `Saving ${files}` : `${files} couldn't be saved`;
}

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
