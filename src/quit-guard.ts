/**
 * quit-guard.ts — pure decision logic for quit/close/update-relaunch confirmation.
 *
 * Mirrors webview/close-dirty.ts: pure functions only, no React, no store imports.
 * All impure orchestration (showing the dialog, IPC, invoking close/install) is
 * done by the caller (electron/main.ts, electron/updater.ts).
 */

import { countNoun } from './menu-selection';
import type { Session } from './types';

export type QuitReason = 'quit' | 'windowClose' | 'update' | 'quitAndStop';
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

// F4: a quit (or an update relaunch) leaves agents running in hc; closing a window or a session
// still ends them.
const STOP_VERB: Record<'windowClose' | 'sessionClose' | 'quitAndStop', string> = {
  windowClose: 'Closing this window',
  quitAndStop: 'Quitting',
  sessionClose: 'Closing',
};

function runningLine(
  reason: 'quit' | 'update' | 'windowClose' | 'sessionClose' | 'quitAndStop',
  running: number,
  busy: number,
  verb: 'will stop' | 'will also stop',
): string {
  const busyClause = busy > 0 ? ` (${busy} actively working)` : '';
  if (reason === 'quit' || reason === 'update')
    return `Your ${countNoun(running, 'agent', 'agents')}${busyClause} will keep running after Conduit closes.`;
  return `${STOP_VERB[reason]} ${verb} ${countNoun(running, 'running agent', 'running agents')}${busyClause}.`;
}

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
  if (running > 0 && reason !== 'sessionMove')
    lines.push(runningLine(reason, running, busy, 'will also stop'));
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
  running: number;
  busy: number;
  reason: QuitReason;
}

export interface QuitConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

export function stopAgentsFailureCopy(reason: string): {
  message: string;
  buttons: string[];
} {
  return {
    message: `Couldn't stop the agents: ${reason}`,
    buttons: ['Retry', 'Quit and leave them running', 'Cancel'],
  };
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
 * The dialog copy for the quit/close/update confirmation: a quit or an update relaunch says the
 * agents keep running (F4); closing a window says they stop. Destructive button "Quit", or
 * "Relaunch & update" for an update.
 */
export function quitConfirmCopy({ running, busy, reason }: QuitConfirmCopyInput): QuitConfirmCopy {
  const title =
    reason === 'quitAndStop'
      ? `Stop ${countNoun(running, 'agent', 'agents')} and quit?`
      : `${running} ${running === 1 ? 'session' : 'sessions'} still running`;
  const line = runningLine(reason, running, busy, 'will stop');
  const body = reason === 'update' ? `${line} Conduit will relaunch to install the update.` : line;
  const confirmLabel =
    reason === 'update' ? 'Relaunch & update' : reason === 'quitAndStop' ? 'Stop and quit' : 'Quit';
  return { title, body, confirmLabel };
}
