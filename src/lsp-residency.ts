// How many language servers stay resident, and which one goes first. Pure: the manager derives a
// snapshot per decision and owns every process. Rules: spec 2026-10-08-language-coverage §2.6.
import type { LspServerState } from './lsp-protocol';
import type { ServerWeight } from './lsp-registry';

export const HEAVY_LIVE_MAX = 2;
export const LIVE_MAX = 4;
export const EVICT_MIN_HIDDEN_MS = 60_000;
export const DORMANT_MS = 600_000;

/** A derived snapshot the manager builds per decision — never stored. */
export interface ResidencyServer {
  key: string;
  weight: ServerWeight;
  state: LspServerState;
  /** Holds (or is about to hold) a process. A record still resolving, absent or restricted
   *  never counts toward a cap. */
  live: boolean;
  visible: boolean;
  /** When it last stopped having a visible doc; creation time if never visible. */
  hiddenSince: number;
  /** Last change / request / became-visible; an invisible open is not activity. */
  lastActivity: number;
  inFlight: number;
}

/** Mid-launch states — `restarting` is a crashed server re-initializing — are never cut short. */
const BUSY: ReadonlySet<LspServerState> = new Set(['starting', 'loading', 'restarting']);

const settled = (s: ResidencyServer): boolean =>
  s.live && !s.visible && s.inFlight === 0 && !BUSY.has(s.state);

export function isEvictable(s: ResidencyServer, now: number): boolean {
  return settled(s) && now - s.hiddenSince >= EVICT_MIN_HIDDEN_MS;
}

export function isDormant(s: ResidencyServer, now: number): boolean {
  return settled(s) && now - Math.max(s.lastActivity, s.hiddenSince) >= DORMANT_MS;
}

/** Keys to stop, LRU first, so that launching `incoming` keeps both caps. `overBudget`: a cap
 *  cannot be met, and the launch goes ahead anyway (soft cap). */
export function planEvictions(
  incoming: { key: string; weight: ServerWeight },
  servers: readonly ResidencyServer[],
  now: number,
): { evict: string[]; overBudget: boolean } {
  const others = servers.filter((s) => s.key !== incoming.key && s.live);
  const candidates = others
    .filter((s) => isEvictable(s, now))
    .sort((a, b) => a.lastActivity - b.lastActivity);
  const evict: string[] = [];
  let heavy =
    others.filter((s) => s.weight === 'heavy').length + (incoming.weight === 'heavy' ? 1 : 0);
  let total = others.length + 1;
  let overBudget = false;
  const take = (weight: ServerWeight | null): boolean => {
    const next = candidates.find(
      (s) => !evict.includes(s.key) && (weight === null || s.weight === weight),
    );
    if (!next) return false;
    evict.push(next.key);
    total--;
    if (next.weight === 'heavy') heavy--;
    return true;
  };
  while (heavy > HEAVY_LIVE_MAX) {
    if (!take('heavy')) {
      overBudget = true;
      break;
    }
  }
  while (total > LIVE_MAX) {
    if (!take(null)) {
      overBudget = true;
      break;
    }
  }
  return { evict, overBudget };
}
