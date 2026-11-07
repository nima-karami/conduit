// list_agents' row for one registry entry (flexible-agent-contracts §4.2). Pure: the host passes the
// facts it knows, so the rules run without a session.

import type { AgentDefinition, AgentSource } from '../types';
import { adapterFor, modelFlagOf, notifiable, supportsBrief } from './adapters';
import type { AgentListing, ListAgentsOutput } from './tools';

export function agentListing(
  def: AgentDefinition,
  source: AgentSource,
  opts: { messagingOn: boolean; e2e: boolean },
): AgentListing {
  const adapter = adapterFor(def, { e2e: opts.e2e });
  // Messaging off means no CONDUIT_* env either, so nothing reaches the agent.
  const messaging: AgentListing['messaging'] =
    !opts.messagingOn || source === 'shell' ? 'none' : adapter ? 'wired' : 'env';
  return {
    id: def.id,
    label: def.label,
    command: def.command,
    source,
    model: modelFlagOf(def) !== undefined,
    messaging,
    notices: adapter !== undefined && notifiable(adapter),
    brief: supportsBrief(adapter),
  };
}

const SOURCE_ORDER: Record<AgentSource, number> = {
  profile: 0,
  launcher: 1,
  detected: 2,
  shell: 3,
};

/** list_agents' output: profile, launcher, detected, shell, then label (flexible-agent-contracts §4.2). */
export function listAgentsOutput(agents: readonly AgentListing[]): ListAgentsOutput {
  const sorted = [...agents].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return { agents: sorted, bare_commands: true };
}
