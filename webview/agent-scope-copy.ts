// Every string of the 12c banner and the 12d missing-home state, and the banner's action model
// (mf-live-edits spec §2.2, §2.6, §3.3). No i18n layer exists; keep strings here, not in JSX.
import type { AgentScopeReason } from '../src/add-dir-delivery';
import { plural } from '../src/plural';
import { sessionNameFromPath } from '../src/session-name';
import type { AgentScopeView } from '../src/types';

/** 'name' renders in a truncating span; the full paths live in the message's title. */
export type CopySegment = { kind: 'text' | 'name'; text: string };
export interface BannerCopy {
  segments: CopySegment[];
  title: string;
  second?: CopySegment[];
}

const text = (t: string): CopySegment => ({ kind: 'text', text: t });
const name = (p: string): CopySegment => ({ kind: 'name', text: sessionNameFromPath(p) });

function folders(paths: readonly string[], pairOk: boolean): CopySegment[] {
  if (paths.length === 1) return [name(paths[0])];
  if (paths.length === 2 && pairOk) return [name(paths[0]), text(' and '), name(paths[1])];
  return [name(paths[0]), text(` and ${plural(paths.length - 1, 'more folder')}`)];
}

export function bannerCopy(view: AgentScopeView): BannerCopy {
  const title = [...view.unseen, ...view.stillSeen].join('\n');
  if (view.unseen.length === 0) {
    return {
      segments: [
        text('claude can still see '),
        ...folders(view.stillSeen, false),
        text(' until it restarts'),
      ],
      title,
    };
  }
  const segments = [text("claude can't see "), ...folders(view.unseen, true), text(' yet')];
  if (view.stillSeen.length === 0) return { segments, title };
  return {
    segments,
    title,
    second: [
      text('It can still see '),
      ...folders(view.stillSeen, false),
      text(' until it restarts.'),
    ],
  };
}

export type BannerPrimary = 'addDir' | 'restart' | null;
export interface BannerActions {
  showAddDir: boolean;
  addDirDisabled: boolean;
  showRestart: boolean;
  primary: BannerPrimary;
}

export function bannerActions(
  view: AgentScopeView,
  o: { busy: boolean; homeMissing: boolean },
): BannerActions {
  const showAddDir = view.unseen.length > 0 && view.typeable.length > 0;
  // The host refuses a restart without a home, so the banner never offers one.
  const showRestart = !o.homeMissing;
  const primary: BannerPrimary = showAddDir ? 'addDir' : showRestart ? 'restart' : null;
  return { showAddDir, addDirDisabled: o.busy, showRestart, primary };
}

export const ADD_DIR_LABEL = 'Run /add-dir';
export const RESTART_LABEL = 'Restart claude';
export const RESTART_CONFIRM_LABEL = 'Restart';
export const CANCEL_LABEL = 'Cancel';
export const DISMISS_LABEL = 'Dismiss';
export const ADD_DIR_BUSY_TITLE = "claude is working — try again when it's idle";
export const RESTART_CONFIRM = 'Restart claude? This conversation ends.';
const ADD_DIR_FAILED = "Couldn't type /add-dir — claude isn't running";

/** null = silent: the UI never offers these, so they are races (log only, spec §3.3). */
export function agentScopeToast(reason: AgentScopeReason): string | null {
  switch (reason) {
    case 'busy':
      return ADD_DIR_BUSY_TITLE;
    case 'writeFailed':
    case 'notRunning':
      return ADD_DIR_FAILED;
    default:
      return null;
  }
}

export const MISSING_HOME_TITLE = 'Home folder not found';
export const LOCATE_LABEL = 'Locate…';
/** The folder name is its own segment so it can truncate inside the button. */
export function asHomeSegments(folder: string): CopySegment[] {
  return [text('Use '), { kind: 'name', text: folder }, text(' as home')];
}
export function asHomeLabel(folder: string): string {
  return asHomeSegments(folder)
    .map((s) => s.text)
    .join('');
}
export function asHomeFailedToast(folder: string): string {
  return `Couldn't make ${folder} the home folder`;
}
