import type { Decision, Profile } from '../../src/conduit-mcp/policy-types';
import type { ToolName } from '../../src/conduit-mcp/tool-policy';

export interface GroupCounts {
  allow: number;
  ask: number;
  deny: number;
}
export type GroupState = 'allowed' | 'mixed' | 'denied';

const ORDER: readonly Decision[] = ['allow', 'ask', 'deny'];

export function groupCounts(profile: Profile, tools: readonly ToolName[]): GroupCounts {
  const counts: GroupCounts = { allow: 0, ask: 0, deny: 0 };
  for (const tool of tools) counts[profile.rules[tool].decision] += 1;
  return counts;
}

export function groupText(counts: GroupCounts): string {
  return ORDER.filter((decision) => counts[decision] > 0)
    .map((decision) => `${counts[decision]} ${decision}`)
    .join(' · ');
}

export function groupState(counts: GroupCounts): GroupState {
  const total = counts.allow + counts.ask + counts.deny;
  if (total > 0 && counts.allow === total) return 'allowed';
  if (total > 0 && counts.deny === total) return 'denied';
  return 'mixed';
}
