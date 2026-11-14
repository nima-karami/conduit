import type { RequestsUiState, RequestView } from '../src/conduit-mcp/request-types';

export type AwayChoice = 'hour' | 'tomorrow9' | 'untilBack';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `now` is injected so callers and tests never read the clock here. */
export function awayUntil(choice: AwayChoice, now: number): string | null {
  if (choice === 'untilBack') return null;
  if (choice === 'hour') return new Date(now + HOUR_MS).toISOString();
  // Local calendar arithmetic: setDate/setHours keep 09:00 across DST changes, where adding 24 h would not.
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

export function awayLabel(until: string | null): string {
  if (until === null) return '';
  const d = new Date(until);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface DigestCounts {
  from: string;
  to: string;
  durationLabel: string;
  stillNeedYou: number;
  wentWithDefault: number;
  expired: number;
  cleared: number;
}

function durationLabel(fromMs: number, toMs: number): string {
  const total = Math.max(0, toMs - fromMs);
  const hours = Math.floor(total / HOUR_MS);
  const minutes = Math.floor((total % HOUR_MS) / MIN_MS);
  return hours > 0 ? `${hours} h ${minutes} m` : `${minutes} m`;
}

export function digestCounts(r: RequestsUiState): DigestCounts | null {
  const away = r.presence.lastAway;
  if (away === null) return null;
  const fromMs = Date.parse(away.from);
  const toMs = Date.parse(away.to);
  const inWindow = (q: RequestView): boolean => {
    if (q.endedAt === null) return false;
    const t = Date.parse(q.endedAt);
    return t >= fromMs && t <= toMs;
  };
  const ended = r.ended.filter(inWindow);
  return {
    from: away.from,
    to: away.to,
    durationLabel: durationLabel(fromMs, toMs),
    stillNeedYou: r.open.length,
    wentWithDefault: ended.filter(
      (q) => q.state === 'answered' && q.answer?.answeredBy.kind === 'default',
    ).length,
    expired: ended.filter((q) => q.state === 'expired').length,
    cleared: ended.filter((q) => q.state === 'resolved').length,
  };
}
