import type { AgentCli, UserInstallState } from '../src/conduit-mcp/install-types';
import type { Handle } from '../src/conduit-mcp/types';
import type { McpNotConnected, McpSessionBadge } from '../src/conduit-mcp/ui-types';

export type CardMcpStatus =
  | { kind: 'connected'; handle: Handle }
  | { kind: 'not-connected'; cli: AgentCli; install: UserInstallState };

// The card already shows an unavailable reason as a warning; a second glyph would contradict it.
// Cursor's is the exception: the host raises not-connected alongside it, and that carries the fix.
export function cardMcpStatus(
  badge: McpSessionBadge | undefined,
  nc: McpNotConnected | undefined,
  enabled: boolean,
): CardMcpStatus | null {
  if (!enabled) return null;
  if (badge?.unavailable && badge.unavailable !== 'cursor-not-connected') return null;

  if (nc) return { kind: 'not-connected', cli: nc.cli, install: nc.install };
  if (badge?.connected) return { kind: 'connected', handle: badge.handle };
  return null;
}
