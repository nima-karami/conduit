import { commandLabel } from './session-command';
import type { AgentDefinition, Session } from './types';

/** The one label a session's agent shows under (sidebar card, board row — spec mf-board D11).
 *  Falls back to the raw id once the agent is no longer registered. */
export function agentLabelFor(
  agents: readonly Pick<AgentDefinition, 'id' | 'label'>[],
  agentId: string,
): string {
  return agents.find((a) => a.id === agentId)?.label ?? agentId;
}

/** A command session is never registered, so its label comes from its own command (spec
 *  2026-10-27-conduit-mcp-control-tools D2), not the synthesized `conduit:command` id. */
export function sessionAgentLabel(
  agents: readonly Pick<AgentDefinition, 'id' | 'label'>[],
  s: Pick<Session, 'agentId' | 'command'>,
): string {
  return s.command ? commandLabel(s.command) : agentLabelFor(agents, s.agentId);
}
