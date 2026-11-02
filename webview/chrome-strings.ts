// User-facing strings for the header, right panel, status bar and update toast: one place for
// the future i18n seam (docs/specs/2026-11-02-sidebar-agent-tree.md §9).

import { attentionChipLabel } from '../src/attention';
import type { RightPaneTab } from '../src/settings';

const count = (n: number): string => n.toLocaleString();
const noun = (n: number, one: string, many: string): string =>
  `${count(n)} ${n === 1 ? one : many}`;
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });

/** A finite 0–100 value; anything else is today's zero fallback (spec §7 floating updates). */
export function clampPercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

export const CHROME_STR = {
  wordmark: 'Conduit',
  devTitle: "Development build — isolated 'Conduit (dev)' profile",
  back: 'Back',
  forward: 'Forward',
  search: 'Search sessions, agents, files',
  searchPlaceholder: 'Search sessions, agents, files…',
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
  view: {
    files: 'Files',
    changes: 'Changes',
    messages: 'Messages',
  } satisfies Record<RightPaneTab, string>,
  changesBadge: (n: number) => noun(n, 'change', 'changes'),
  messagesBadge: (unread: number, urgent: number) =>
    urgent > 0
      ? `${noun(unread, 'unread message', 'unread messages')}, ${noun(urgent, 'urgent message', 'urgent messages')}`
      : noun(unread, 'unread message', 'unread messages'),
  panelGroup: 'Side panel',
  movePanel: 'Move side panel',
  statusBar: 'Session status',
  machine: 'This computer',
  worktree: 'worktree',
  agents: (n: number) => noun(n, 'agent', 'agents'),
  /** The footer button's name is the chip's own copy, so the two can never disagree. */
  needYou: (n: number) => attentionChipLabel(n) ?? '',
  commands: (combo: string) => `${combo} commands`,
  update: {
    updating: (version: string | undefined) => `Updating to v${version ?? '?'}…`,
    ready: (version: string | undefined) => `v${version ?? '?'} ready`,
    relaunch: 'Relaunch to update',
    dismiss: 'Dismiss update',
    download: 'Update download',
    percent: (value: number) => percent.format(value / 100),
  },
};
