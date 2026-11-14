// Node-free: the renderer imports these rules. The Needs you panel, the pop-up and the tab only render them.
import type { RequestView } from '../src/conduit-mcp/request-types';
import { REQ_STR } from './request-strings';

export type RequestType = 'approve' | 'answer' | 'review';
export type OpenAs = 'popup' | 'tab' | 'terminal';
export type SortKey = 'soonest' | 'newest' | 'oldest' | 'session';
export interface RequestFilters {
  sessions: string[];
  leads: string[];
  spaces: string[];
  types: RequestType[];
  machines: string[];
}
export const NO_FILTERS: RequestFilters = {
  sessions: [],
  leads: [],
  spaces: [],
  types: [],
  machines: [],
};
export interface SessionInfo {
  name: string;
  handle: string | null;
}
export interface CardView {
  id: string;
  type: RequestType;
  conduit: boolean;
  openAs: OpenAs;
  tabLines: number | null;
  sessionId: string | null;
  sessionName: string;
  handle: string;
  ask: string;
  whyNow:
    | { kind: 'waiting'; secondsLeft: number }
    | { kind: 'urgent' }
    | { kind: 'expires'; at: string }
    | { kind: 'tab'; lines: number }
    | { kind: 'terminal' }
    | { kind: 'age'; label: string };
  details: { space: string | null; age: string; machine: string };
  ariaName: string;
}

const MIN_MS = 60_000;
// see docs/specs/2026-11-14-user-input-requests.md §4.4
const POPUP_MAX_CHARS = 600;
const POPUP_MAX_LINES = 8;
const POPUP_MAX_OPTIONS = 4;
const POPUP_MAX_OPTION_DESC = 100;
const TYPE_ORDER: readonly RequestType[] = ['approve', 'answer', 'review'];

const secondsUntil = (untilMs: number, now: number): number =>
  Math.max(0, Math.ceil((untilMs - now) / 1000));

function spanLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MIN_MS);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function draftLines(draft: string | null): number {
  const parts = (draft ?? '').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export function typeOf(r: RequestView): RequestType {
  switch (r.kind) {
    case 'confirm':
      return 'approve';
    case 'choose':
    case 'text':
      return 'answer';
    case 'review':
      return 'review';
    case 'attend':
      return r.blocked === 'permission' ? 'approve' : 'answer';
  }
}

export function isConduit(r: RequestView): boolean {
  return r.requester === 'conduit' || r.source === 'observed' || r.source === 'scheduler';
}

export function bodyLines(r: RequestView): number {
  return r.body === '' ? 0 : r.body.split('\n').length;
}

export function openAsOf(r: RequestView): OpenAs {
  if (r.kind === 'review') return 'tab';
  if (r.kind === 'attend') return 'terminal';
  const fitsPopup =
    r.body.length <= POPUP_MAX_CHARS &&
    bodyLines(r) <= POPUP_MAX_LINES &&
    r.options.length <= POPUP_MAX_OPTIONS &&
    r.options.every((o) => (o.description ?? '').length <= POPUP_MAX_OPTION_DESC);
  return fitsPopup ? 'popup' : 'tab';
}

function tabLinesOf(r: RequestView): number {
  return r.kind === 'review' ? draftLines(r.draft) : bodyLines(r);
}

const byNullableAsc = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return Date.parse(a) - Date.parse(b);
};

const byCreatedAsc = (a: RequestView, b: RequestView): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt);

// A waiting call blocks on the human right now, so the soonest order puts it first.
const soonestRank = (r: RequestView): number => (r.waiting ? 0 : r.priority === 'urgent' ? 1 : 2);

function bySoonest(a: RequestView, b: RequestView): number {
  const rank = soonestRank(a) - soonestRank(b);
  if (rank !== 0) return rank;
  if (a.waiting) return byNullableAsc(a.waitingUntil, b.waitingUntil) || byCreatedAsc(a, b);
  return byNullableAsc(a.expiresAt, b.expiresAt) || byCreatedAsc(a, b);
}

export function sortRequests(
  rs: readonly RequestView[],
  key: SortKey,
  sessions: ReadonlyMap<string, SessionInfo>,
): RequestView[] {
  switch (key) {
    case 'soonest':
      return [...rs].sort(bySoonest);
    case 'oldest':
      return [...rs].sort(byCreatedAsc);
    case 'newest':
      return [...rs].sort((a, b) => byCreatedAsc(b, a));
    case 'session': {
      // A session's asks read as one thread, so they stay together; soonest leads inside each group.
      const groups = new Map<string | null, RequestView[]>();
      for (const r of rs) {
        const group = groups.get(r.session);
        if (group) group.push(r);
        else groups.set(r.session, [r]);
      }
      const nameOf = (id: string | null) => (id === null ? '' : (sessions.get(id)?.name ?? ''));
      return [...groups.entries()]
        .sort(([a], [b]) => nameOf(a).localeCompare(nameOf(b)))
        .flatMap(([, group]) => [...group].sort(bySoonest));
    }
  }
}

const allows = (list: readonly string[], value: string | null): boolean =>
  list.length === 0 || (value !== null && list.includes(value));

function matchesFilters(r: RequestView, f: RequestFilters): boolean {
  return (
    allows(f.sessions, r.session) &&
    allows(f.leads, r.lead) &&
    allows(f.spaces, r.space) &&
    (f.types.length === 0 || f.types.includes(typeOf(r))) &&
    allows(f.machines, r.machine)
  );
}

export function applyFilters(
  rs: readonly RequestView[],
  f: RequestFilters,
): { shown: RequestView[]; hiddenCount: number } {
  // A waiting call is blocked on the human right now; no filter may hide it.
  const shown = rs.filter((r) => r.waiting || matchesFilters(r, f));
  return { shown, hiddenCount: rs.length - shown.length };
}

function whyNowOf(
  r: RequestView,
  openAs: OpenAs,
  tabLines: number | null,
  now: number,
): CardView['whyNow'] {
  if (r.waiting && r.waitingUntil !== null) {
    return { kind: 'waiting', secondsLeft: secondsUntil(Date.parse(r.waitingUntil), now) };
  }
  if (r.priority === 'urgent') return { kind: 'urgent' };
  if (r.expiresAt !== null) return { kind: 'expires', at: r.expiresAt };
  if (tabLines !== null) return { kind: 'tab', lines: tabLines };
  if (openAs === 'terminal') return { kind: 'terminal' };
  return { kind: 'age', label: ageLabel(r.createdAt, now) };
}

function whyText(why: CardView['whyNow'], now: number): string {
  switch (why.kind) {
    case 'waiting':
      return REQ_STR.waiting(why.secondsLeft);
    case 'urgent':
      return REQ_STR.urgent;
    case 'expires':
      return REQ_STR.expires(spanLabel(Date.parse(why.at) - now));
    case 'tab':
      return REQ_STR.tabLines(why.lines);
    case 'terminal':
      return REQ_STR.inTerminal;
    case 'age':
      return why.label;
  }
}

export function cardsOf(
  rs: readonly RequestView[],
  ctx: {
    now: number;
    sessions: ReadonlyMap<string, SessionInfo>;
    spaces: ReadonlyMap<string, string>;
  },
): CardView[] {
  return rs.map((r) => {
    const type = typeOf(r);
    const openAs = openAsOf(r);
    const tabLines = openAs === 'tab' ? tabLinesOf(r) : null;
    const session = r.session === null ? undefined : ctx.sessions.get(r.session);
    const sessionName = session?.name ?? '';
    const handle = r.requester === 'conduit' ? (session?.handle ?? '') : r.requester;
    const whyNow = whyNowOf(r, openAs, tabLines, ctx.now);
    const space = r.space === null ? null : (ctx.spaces.get(r.space) ?? null);
    return {
      id: r.id,
      type,
      conduit: isConduit(r),
      openAs,
      tabLines,
      sessionId: r.session,
      sessionName,
      handle,
      ask: r.title,
      whyNow,
      details: { space, age: ageLabel(r.createdAt, ctx.now), machine: r.machine },
      ariaName: `${REQ_STR.typeWord[type]}, ${sessionName}, ${handle}: ${r.title}, ${whyText(whyNow, ctx.now)}`,
    };
  });
}

export function shortestWaiting(
  rs: readonly RequestView[],
  now: number,
): { requestId: string; sessionId: string | null; secondsLeft: number } | null {
  let best: { r: RequestView; until: number } | null = null;
  for (const r of rs) {
    if (!r.waiting || r.waitingUntil === null) continue;
    const until = Date.parse(r.waitingUntil);
    if (best === null || until < best.until) best = { r, until };
  }
  if (best === null) return null;
  return {
    requestId: best.r.id,
    sessionId: best.r.session,
    secondsLeft: secondsUntil(best.until, now),
  };
}

const distinctPresent = (values: ReadonlyArray<string | null>): string[] => [
  ...new Set(values.filter((v): v is string => v !== null)),
];

const byLabel = (a: { label: string }, b: { label: string }): number =>
  a.label.localeCompare(b.label);

export function filterOptions(
  rs: readonly RequestView[],
  ctx: { sessions: ReadonlyMap<string, SessionInfo>; spaces: ReadonlyMap<string, string> },
): {
  sessions: Array<{ id: string; label: string }>;
  leads: Array<{ id: string; label: string }>;
  spaces: Array<{ id: string; label: string }>;
  types: RequestType[];
  machines: string[];
} {
  const labelled = (ids: string[], names: ReadonlyMap<string, string>) =>
    ids.map((id) => ({ id, label: names.get(id) ?? id })).sort(byLabel);
  const sessionName = new Map([...ctx.sessions].map(([id, s]) => [id, s.name]));
  return {
    sessions: labelled(distinctPresent(rs.map((r) => r.session)), sessionName),
    leads: labelled(distinctPresent(rs.map((r) => r.lead)), sessionName),
    spaces: labelled(distinctPresent(rs.map((r) => r.space)), ctx.spaces),
    types: TYPE_ORDER.filter((t) => rs.some((r) => typeOf(r) === t)),
    machines: [...new Set(rs.map((r) => r.machine))].sort((a, b) => a.localeCompare(b)),
  };
}

export function ageLabel(fromIso: string, now: number): string {
  return spanLabel(now - Date.parse(fromIso));
}
