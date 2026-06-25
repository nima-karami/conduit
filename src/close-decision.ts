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
