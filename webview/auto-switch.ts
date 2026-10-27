import type { Session } from '../src/types';

/** The newest running session among `added`, skipping ids an MCP open asked to keep in the
 *  background (spec 2026-10-27-conduit-mcp-control-tools §3.1, focus). */
export function pickAutoSwitch(
  added: readonly Pick<Session, 'id' | 'status' | 'createdAt'>[],
  suppressed: ReadonlySet<string>,
): string | undefined {
  let best: Pick<Session, 'id' | 'createdAt'> | undefined;
  for (const s of added) {
    if (s.status !== 'running' || suppressed.has(s.id)) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best?.id;
}
