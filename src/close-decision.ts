/**
 * Decide whether closing a session warrants a confirmation dialog.
 *
 * Closing only loses something worth guarding when an actual coding agent is running
 * (Claude Code / Codex — i.e. a non-shell agent) OR the session owns open editor tabs.
 * A plain shell sitting at a prompt with no open editors closes silently, even with
 * the confirm-on-close setting on.
 */
export function shouldConfirmClose(input: {
  status: string;
  /** Session agent id. Plain shells start with `shell:` (or are undefined). */
  agentId?: string;
  /** Whether the session owns any open editor doc tabs. */
  hasOpenEditors: boolean;
  /** The user's confirm-on-close-running setting. */
  confirmEnabled: boolean;
}): boolean {
  if (input.status !== 'running' || !input.confirmEnabled) return false;
  const isAgent = !!input.agentId && !input.agentId.startsWith('shell:');
  return isAgent || input.hasOpenEditors;
}

/** What to do when a session's PTY exits on its own (e.g. the user typed `exit`). */
export type ExitAction = 'close' | 'warn' | 'ignore';

/**
 * Decide how to react when a session's process exits:
 *  - plain shell, no open editors → `close` the session (the terminal is done).
 *  - plain shell with open editors → `warn` before closing (don't silently drop tabs).
 *  - coding agent (Claude Code / Codex) → `ignore`: keep the "Process exited / Restart"
 *    card, since an agent exiting is notable and the user likely wants to relaunch.
 */
export function sessionExitAction(input: {
  agentId?: string;
  hasOpenEditors: boolean;
}): ExitAction {
  const isAgent = !!input.agentId && !input.agentId.startsWith('shell:');
  if (isAgent) return 'ignore';
  return input.hasOpenEditors ? 'warn' : 'close';
}
