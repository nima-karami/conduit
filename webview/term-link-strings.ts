// User-facing strings for terminal path links: one place for the future i18n seam (spec
// 2026-10-16-terminal-path-links §10).
import { countNoun } from '../src/menu-selection';

const count = new Intl.NumberFormat('en-US');

export const TERM_LINK_STR = {
  matches: (n: number) => countNoun(n, 'match', 'matches'),
  heading: (token: string, n: number) => `${token} · ${countNoun(n, 'match', 'matches')}`,
  pickFor: (actionLabel: string) => `${actionLabel} — pick a match`,
  showingOf: (shown: number, total: number) =>
    `Showing ${count.format(shown)} of ${count.format(total)}`,
  searchAll: 'Search all files…',
  noMatches: (q: string) => `No matches for “${q}”`,
  noLongerExists: (name: string) => `${name} no longer exists`,
  open: 'Open',
  showAll: 'Show all matches',
  copyPath: 'Copy path',
  copyRelativePath: 'Copy relative path',
  reveal: 'Reveal in Explorer',
  openAsSession: 'Open as new session',
  workingHere: 'working here',
  worktree: 'worktree',
} as const;
