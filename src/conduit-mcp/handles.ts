import type { Handle } from './types';

// Handle rule: docs/specs/2026-10-25-conduit-mcp-server.md §3.1 (prefix = adapter id, see plan
// Spec staleness).

export function slugHandlePrefix(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type HandleCounters = Readonly<Record<string, number>>;

/** Numbers are never reused, so a handle in an old message never names a newer session. */
export function allocateHandle(
  counters: HandleCounters,
  prefix: string,
): { handle: Handle; counters: HandleCounters } {
  const n = (counters[prefix] ?? 0) + 1;
  return { handle: `${prefix}-${n}`, counters: { ...counters, [prefix]: n } };
}

export function parseHandleCounters(text: string | undefined): HandleCounters {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

export function serializeHandleCounters(c: HandleCounters): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}
