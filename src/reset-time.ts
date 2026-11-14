import type { ResetFormat } from './contracts/auto-resume';
import { resolveClockTime } from './timed-messages';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// see spec 2026-11-13-scheduler-auto-resume §3 "Text-rule fallback"
const MAX_AHEAD_MS = 8 * DAY_MS;
const MAX_BEHIND_MS = DAY_MS;

const IANA_ZONE = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/;
const TWELVE_HOUR = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?\b/i;
const TWENTY_FOUR_HOUR = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const COUNTDOWN_CLOCK = /\bin\s+\d/i;
const MONTH_DAY =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?(?:\s+(\d{4})\b)?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DURATION_TEXT = /^\s*(?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+$/i;
const DURATION_UNIT = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi;
const HOUR_MINUTE = /^\s*(\d{1,3}):([0-5]\d)\s*$/;

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function formatterFor(zone: string | undefined): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  };
  if (zone) {
    try {
      return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
    } catch {
      // an abbreviation such as EDT is not an IANA id; the machine zone applies, as resolveClockTime does
    }
  }
  return new Intl.DateTimeFormat('en-US', options);
}

function wallAt(fmt: Intl.DateTimeFormat, at: number): Wall {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(at))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
  };
}

function offsetMs(fmt: Intl.DateTimeFormat, at: number): number {
  const w = wallAt(fmt, at);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

function instantFor(
  fmt: Intl.DateTimeFormat,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  const first = target - offsetMs(fmt, target);
  return target - offsetMs(fmt, first);
}

const pad = (n: number): string => String(n).padStart(2, '0');

function clockOf(text: string): string | null {
  const twelve = TWELVE_HOUR.exec(text);
  if (twelve) {
    const raw = Number(twelve[1]);
    if (raw < 1 || raw > 12) return null;
    const pm = twelve[3]?.toLowerCase() === 'p';
    const hour = pm ? (raw === 12 ? 12 : raw + 12) : raw === 12 ? 0 : raw;
    return `${pad(hour)}:${twelve[2] ?? '00'}`;
  }
  const twentyFour = TWENTY_FOUR_HOUR.exec(text);
  if (twentyFour) return `${pad(Number(twentyFour[1]))}:${twentyFour[2]}`;
  return null;
}

function clockInstant(text: string, zone: string | undefined, now: number): number | null {
  const clock = clockOf(text);
  return clock === null ? null : resolveClockTime(clock, zone, now);
}

function dateInstant(text: string, zone: string | undefined, now: number): number | null {
  const m = MONTH_DAY.exec(text);
  const monthName = m?.[1];
  if (!m || !monthName) return null;
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
  const day = Number(m[2]);
  const clock = clockOf(text.slice(m.index + m[0].length));
  if (month === 0 || clock === null) return null;
  const [h, mi] = clock.split(':').map(Number) as [number, number];
  const fmt = formatterFor(zone);
  if (m[3]) return instantFor(fmt, Number(m[3]), month, day, h, mi);
  const thisYear = wallAt(fmt, now).y;
  for (const y of [thisYear, thisYear + 1]) {
    const at = instantFor(fmt, y, month, day, h, mi);
    if (at >= now - MAX_BEHIND_MS) return at;
  }
  return null;
}

function durationMs(text: string): number | null {
  const hm = HOUR_MINUTE.exec(text);
  if (hm) return Number(hm[1]) * HOUR_MS + Number(hm[2]) * MINUTE_MS;
  if (!DURATION_TEXT.test(text)) return null;
  let total = 0;
  for (const u of text.matchAll(DURATION_UNIT)) {
    const amount = Number(u[1]);
    total += u[2]?.toLowerCase().startsWith('h') ? amount * HOUR_MS : amount * MINUTE_MS;
  }
  return total;
}

// the captured group is the reset phrase alone, so a log stamp before it is never read as the time
export function parseResetText(text: string, format: ResetFormat, now: number): number | null {
  let at: number | null;
  if (format === 'countdown') {
    const ms = durationMs(text);
    at = ms === null ? null : now + ms;
  } else if (COUNTDOWN_CLOCK.test(text)) {
    return null;
  } else {
    const zone = IANA_ZONE.exec(text)?.[1];
    at =
      format === 'clock-or-date' && MONTH_DAY.test(text)
        ? dateInstant(text, zone, now)
        : clockInstant(text, zone, now);
  }
  if (at === null || at > now + MAX_AHEAD_MS || at < now - MAX_BEHIND_MS) return null;
  return at;
}
