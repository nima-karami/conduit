import type { AgentDefinition } from './types';

/** The one label a session's agent shows under (sidebar card, board row — spec mf-board D11).
 *  Falls back to the raw id once the agent is no longer registered. */
export function agentLabelFor(
  agents: readonly Pick<AgentDefinition, 'id' | 'label'>[],
  agentId: string,
): string {
  return agents.find((a) => a.id === agentId)?.label ?? agentId;
}
