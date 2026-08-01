// The two data-backed routes on the empty state (§7.2): "Open a shell" and "Reopen last".
// Both resolve to a real folder + a real agent or they resolve to nothing — a route that
// cannot be honoured is not rendered, so the UI never offers a dead control.

import type { RepoDTO } from './protocol';
import type { AgentDefinition } from './types';

export interface StartTarget {
  path: string;
  /** Empty string = let the host pick its first registered terminal. */
  agentId: string;
}

export interface ReopenTarget extends StartTarget {
  repoName: string;
  /** Only set when the remembered agent is still installed; the sub-label omits it otherwise. */
  agentLabel?: string;
  ageMs: number;
}

/**
 * The folder + agent "Reopen last" would restore, or null when there is no history.
 *
 * `reposForState()` always appends a Home entry stamped `lastOpened: 0`, so a non-empty
 * repo list is NOT evidence of history — only a non-zero stamp is.
 */
export function lastSessionTarget(
  repos: RepoDTO[],
  agents: AgentDefinition[],
  now: number,
): ReopenTarget | null {
  let recent: RepoDTO | undefined;
  for (const r of repos) {
    if (r.lastOpened > 0 && (!recent || r.lastOpened > recent.lastOpened)) recent = r;
  }
  if (!recent) return null;
  const agent = agents.find((a) => a.id === recent.lastAgentId);
  return {
    path: recent.path,
    agentId: agent?.id ?? '',
    repoName: recent.name,
    agentLabel: agent?.label,
    ageMs: Math.max(0, now - recent.lastOpened),
  };
}

/**
 * The folder + shell "Open a shell" would launch. The route promises "no agent", so it
 * only ever picks a `shell:` terminal — with none registered there is no honest route.
 */
export function plainShellTarget(
  repos: RepoDTO[],
  agents: AgentDefinition[],
  preferredAgentId?: string,
): StartTarget | null {
  const shells = agents.filter((a) => a.id.startsWith('shell:'));
  const shell = shells.find((a) => a.id === preferredAgentId) ?? shells[0];
  // repos[0] is the most recently opened existing folder, or Home on a fresh profile.
  const dir = repos[0];
  if (!shell || !dir) return null;
  return { path: dir.path, agentId: shell.id };
}

/** Coarse "how long ago", one unit, for the Reopen-last sub-label. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
