// Address grammar: docs/plans/2026-11-14-conduit-network-machinery.plan.md, decision 9 (NET-D14).
// Handles follow src/conduit-mcp/handles.ts; machine text is user-typed, so tools resolve it later.

const HANDLE = /^[a-z0-9-]+$/;
const MAX_LENGTH = 200;

export function parseAddress(s: string): { handle: string; machine: string | null } | null {
  if (s.length === 0 || s.length > MAX_LENGTH || /\s/.test(s)) return null;
  const parts = s.split('@');
  if (parts.length > 2) return null;
  const handle = parts[0] ?? '';
  if (handle !== 'you' && !HANDLE.test(handle)) return null;
  if (parts.length === 1) return { handle, machine: null };
  const machine = parts[1] ?? '';
  if (machine.length === 0) return null;
  return { handle, machine };
}

export function formatAddress(handle: string, machineId: string): string {
  return `${handle}@${machineId}`;
}

/**
 * A peer whose name collides with another peer or with self is shown as `name (machineId)`, so
 * the two stay distinguishable. Collisions compare case-insensitively after trimming.
 */
export function displayNames(
  peers: { machineId: string; name: string }[],
  selfName: string,
): Map<string, string> {
  const key = (name: string) => name.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const peer of peers) {
    counts.set(key(peer.name), (counts.get(key(peer.name)) ?? 0) + 1);
  }
  const selfKey = key(selfName);
  const out = new Map<string, string>();
  for (const peer of peers) {
    const name = peer.name.trim();
    const k = key(peer.name);
    const clashes = (counts.get(k) ?? 0) > 1 || k === selfKey;
    out.set(peer.machineId, clashes ? `${name} (${peer.machineId})` : name);
  }
  return out;
}
