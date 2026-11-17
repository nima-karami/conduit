import type { ActivityEntry, ActivityLane } from './activity-log';
import type { Decision } from './policy-types';
import { CLI_KINDS, type CliKind } from './tool-policy';

export interface ActivityQuery {
  sessionId?: string;
  cli?: CliKind;
  machineId?: string;
  decision?: Decision;
  action?: string;
  lane?: ActivityLane;
  since?: string;
  before?: string;
  limit?: number;
}

export interface ActivityPage {
  rows: ActivityEntry[];
  next: string | null;
  writable: boolean;
  error: string | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const boundedText = (value: unknown): value is string =>
  text(value) &&
  value.length > 0 &&
  value.length <= 512 &&
  Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const isoTime = (value: unknown): value is string =>
  text(value) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const nullableNonnegative = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  choices.some((choice) => choice === value);

export function isActivityDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && isoTime(`${day}T00:00:00.000Z`);
}

export function activityCursor(row: Pick<ActivityEntry, 'at' | 'id'>): string {
  return encodeURIComponent(JSON.stringify([row.at, row.id]));
}

function cursorParts(value: unknown): [string, string] | null {
  if (!text(value) || value.length > 4096) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
  return Array.isArray(raw) && raw.length === 2 && isoTime(raw[0]) && boundedText(raw[1])
    ? [raw[0], raw[1]]
    : null;
}

export function parseActivityQuery(value: unknown): ActivityQuery | null {
  if (!object(value)) return null;
  const allowed = [
    'sessionId',
    'cli',
    'machineId',
    'decision',
    'action',
    'lane',
    'since',
    'before',
    'limit',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  for (const key of ['sessionId', 'machineId', 'action']) {
    if (value[key] !== undefined && !boundedText(value[key])) return null;
  }
  if (value.cli !== undefined && !oneOf(value.cli, CLI_KINDS)) return null;
  if (value.decision !== undefined && !oneOf(value.decision, ['allow', 'ask', 'deny'])) return null;
  if (value.lane !== undefined && !oneOf(value.lane, ['conduit', 'observed', 'note'])) return null;
  if (value.since !== undefined && !isoTime(value.since)) return null;
  if (value.before !== undefined && cursorParts(value.before) === null) return null;
  if (
    value.limit !== undefined &&
    (typeof value.limit !== 'number' ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 200)
  )
    return null;
  return { ...value } as ActivityQuery;
}

export function compareActivityRows(
  a: Pick<ActivityEntry, 'at' | 'id'>,
  b: Pick<ActivityEntry, 'at' | 'id'>,
): number {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

export function activityMatches(row: ActivityEntry, query: ActivityQuery): boolean {
  const before = query.before === undefined ? null : cursorParts(query.before);
  return (
    (query.sessionId === undefined || row.principal.sessionId === query.sessionId) &&
    (query.cli === undefined || row.cli === query.cli) &&
    (query.machineId === undefined || row.principal.machineId === query.machineId) &&
    (query.decision === undefined || row.decision === query.decision) &&
    (query.action === undefined || row.action === query.action) &&
    (query.lane === undefined || row.lane === query.lane) &&
    (query.since === undefined || row.at >= query.since) &&
    (before === null || compareActivityRows(row, { at: before[0], id: before[1] }) > 0)
  );
}

export function parseActivityEntry(value: unknown): ActivityEntry | null {
  if (!object(value) || !object(value.principal)) return null;
  const p = value.principal;
  if (
    value.v !== 1 ||
    !boundedText(value.id) ||
    !isoTime(value.at) ||
    !oneOf(value.lane, ['conduit', 'observed', 'note']) ||
    !nullableText(p.handle) ||
    !nullableText(p.sessionId) ||
    !nullableText(p.machineId) ||
    !(value.cli === null || oneOf(value.cli, CLI_KINDS)) ||
    !text(value.action) ||
    !nullableText(value.target) ||
    !nullableText(value.summary) ||
    !(value.decision === null || oneOf(value.decision, ['allow', 'ask', 'deny'])) ||
    !text(value.decidedBy) ||
    !(
      value.outcome === null ||
      oneOf(value.outcome, ['ok', 'error', 'denied', 'refused', 'expired', 'withdrawn', 'asked'])
    ) ||
    !nullableNonnegative(value.durationMs) ||
    !nullableText(value.requestId) ||
    !nullableNonnegative(value.count) ||
    (value.count !== null && !Number.isInteger(value.count))
  )
    return null;
  return {
    v: 1,
    id: value.id,
    at: value.at,
    lane: value.lane,
    principal: { handle: p.handle, sessionId: p.sessionId, machineId: p.machineId },
    cli: value.cli,
    action: value.action,
    target: value.target,
    summary: value.summary,
    decision: value.decision,
    decidedBy: value.decidedBy,
    outcome: value.outcome,
    durationMs: value.durationMs,
    requestId: value.requestId,
    count: value.count,
  };
}
