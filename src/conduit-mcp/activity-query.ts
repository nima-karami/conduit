import { folderKey } from '../folder-key';
import type { ActivityEntry, ActivityLane } from './activity-log';
import type { ActivityDecisionTraceV1, AssignmentPoint, Decision, Reason } from './policy-types';
import {
  CLI_KINDS,
  type CliKind,
  MOVE_VALUES,
  REACH_VALUES,
  TOOL_NAMES,
  WHEN_VALUES,
} from './tool-policy';

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

const safeText = (v: unknown): v is string => boundedText(v) && !/[\u0080-\u009f]/.test(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const safeNullable = (v: unknown): boolean => v === null || safeText(v);
const absolutePath = (v: unknown): boolean =>
  v === null ||
  (safeText(v) &&
    (/^\/(?!\/)/.test(v) || /^[A-Za-z]:\\/.test(v) || /^\\\\[^\\]+\\[^\\]+/.test(v)) &&
    !v.split(/[\\/]/).some((p) => p === '.' || p === '..'));
const point = (v: unknown): boolean => {
  if (!object(v)) return false;
  switch (v.kind) {
    case 'default':
      return exact(v, ['kind']);
    case 'session':
      return exact(v, ['kind', 'sessionId']) && safeText(v.sessionId);
    case 'peer':
      return exact(v, ['kind', 'machineId']) && safeText(v.machineId);
    case 'cli':
      return exact(v, ['kind', 'cli']) && oneOf(v.cli, CLI_KINDS);
    default:
      return false;
  }
};
const profileId = (v: unknown): boolean =>
  safeText(v) && (oneOf(v, ['observer', 'worker', 'lead']) || v.startsWith('p-'));
const reason = (v: unknown): boolean => {
  if (!object(v)) return false;
  switch (v.by) {
    case 'floor':
      return (
        exact(v, ['by', 'floor']) &&
        oneOf(v.floor, ['master-off', 'remote-capability', 'local-to-you'])
      );
    case 'deny':
      return exact(v, ['by', 'point']) && point(v.point);
    case 'session-deny':
      return exact(v, ['by', 'denialId']) && safeText(v.denialId);
    case 'grant':
      return exact(v, ['by', 'grantId']) && safeText(v.grantId);
    case 'override':
      return exact(v, ['by', 'overrideId']) && safeText(v.overrideId);
    case 'profile':
    case 'exception':
      return exact(v, ['by', 'point', 'profileId']) && point(v.point) && profileId(v.profileId);
    default:
      return false;
  }
};
const decision = (v: unknown): boolean => oneOf(v, ['allow', 'ask', 'deny']);
const principal = (v: unknown): boolean => {
  if (!object(v)) return false;
  if (v.kind === 'session')
    return (
      exact(v, ['kind', 'sessionId', 'launchedCli', 'generation', 'projectId']) &&
      safeText(v.sessionId) &&
      (v.launchedCli === null || oneOf(v.launchedCli, CLI_KINDS)) &&
      (v.generation === null ||
        (Number.isSafeInteger(v.generation) && (v.generation as number) > 0)) &&
      safeNullable(v.projectId)
    );
  if (
    v.kind !== 'remote' ||
    !exact(v, ['kind', 'machineId', 'handle', 'trust', 'controller', 'capabilities']) ||
    !object(v.capabilities)
  )
    return false;
  return (
    safeText(v.machineId) &&
    safeText(v.handle) &&
    v.trust === 'own' &&
    typeof v.controller === 'boolean' &&
    exact(v.capabilities, ['messaging', 'monitor', 'drive']) &&
    Object.values(v.capabilities).every((c) => typeof c === 'boolean')
  );
};
const target = (v: unknown): boolean =>
  object(v) &&
  exact(v, ['sessionId', 'path', 'folder', 'projectId']) &&
  safeNullable(v.sessionId) &&
  absolutePath(v.path) &&
  absolutePath(v.folder) &&
  safeNullable(v.projectId);

function copyTraceValue(value: unknown, depth: number, budget: { nodes: number }): unknown {
  if (++budget.nodes > 1024 || depth > 8) throw new Error('Invalid trace');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > 512) throw new Error('Invalid trace');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 16) throw new Error('Invalid trace');
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) result.push(copyTraceValue(value[i], depth + 1, budget));
    return result;
  }
  if (!object(value)) throw new Error('Invalid trace');
  const keys = Object.keys(value);
  if (keys.length > 16) throw new Error('Invalid trace');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) result[key] = copyTraceValue(value[key], depth + 1, budget);
  return result;
}

export function parseActivityTrace(value: unknown): ActivityDecisionTraceV1 | null {
  let v: unknown;
  try {
    v = copyTraceValue(value, 0, { nodes: 0 });
  } catch {
    return null;
  }
  if (
    !object(v) ||
    !exact(v, [
      'v',
      'decidedAt',
      'facts',
      'decision',
      'reason',
      'rule',
      'forcedAsk',
      'assignment',
      'runtime',
      'stages',
      'withoutWinner',
      ...(Object.hasOwn(v, 'winnerDigest') ? ['winnerDigest'] : []),
    ])
  )
    return null;
  const f = v.facts;
  if (
    v.v !== 1 ||
    !isoTime(v.decidedAt) ||
    !object(f) ||
    !exact(f, ['v', 'principal', 'tool', 'targets', 'masterOn', 'toYou', 'forceAsk']) ||
    f.v !== 1 ||
    !principal(f.principal) ||
    !oneOf(f.tool, TOOL_NAMES) ||
    !Array.isArray(f.targets) ||
    f.targets.length > 16 ||
    !f.targets.every(target) ||
    new Set(
      f.targets.map((t) =>
        JSON.stringify([
          t.sessionId,
          t.path === null ? null : folderKey(t.path),
          t.folder === null ? null : folderKey(t.folder),
          t.projectId,
        ]),
      ),
    ).size !== f.targets.length ||
    typeof f.masterOn !== 'boolean' ||
    typeof f.toYou !== 'boolean' ||
    typeof f.forceAsk !== 'boolean'
  )
    return null;
  if (
    !decision(v.decision) ||
    !reason(v.reason) ||
    !object(v.rule) ||
    !exact(v.rule, ['when', 'reach', 'move']) ||
    !(v.rule.when === null || oneOf(v.rule.when, WHEN_VALUES)) ||
    !(v.rule.reach === null || oneOf(v.rule.reach, REACH_VALUES)) ||
    !(v.rule.move === null || oneOf(v.rule.move, MOVE_VALUES)) ||
    typeof v.forcedAsk !== 'boolean'
  )
    return null;
  if (
    v.assignment !== null &&
    (!object(v.assignment) ||
      !exact(v.assignment, ['point', 'profileId', 'profileName']) ||
      !point(v.assignment.point) ||
      !profileId(v.assignment.profileId) ||
      !safeText(v.assignment.profileName) ||
      v.assignment.profileName.length > 128)
  )
    return null;
  if (
    !object(v.runtime) ||
    !exact(v.runtime, ['outcome', 'code']) ||
    !oneOf(v.runtime.outcome, ['not-reached', 'proceeded', 'refused', 'unknown']) ||
    v.runtime.code !== null
  )
    return null;
  if (
    !Array.isArray(v.stages) ||
    v.stages.length > 4 ||
    new Set(v.stages).size !== v.stages.length ||
    !v.stages.every((stage) => oneOf(stage, ['floors', 'explicit-deny', 'grants', 'assignment']))
  )
    return null;
  if (
    v.withoutWinner !== null &&
    (!object(v.withoutWinner) ||
      !exact(v.withoutWinner, ['decision', 'reason']) ||
      !decision(v.withoutWinner.decision) ||
      !reason(v.withoutWinner.reason))
  )
    return null;
  if (
    v.winnerDigest !== undefined &&
    (typeof v.winnerDigest !== 'string' || !/^[0-9a-f]{64}$/.test(v.winnerDigest))
  )
    return null;
  const source = v as unknown as ActivityDecisionTraceV1;
  const p = source.facts.principal;
  const copiedPrincipal =
    p.kind === 'session'
      ? {
          kind: p.kind,
          sessionId: p.sessionId,
          launchedCli: p.launchedCli,
          generation: p.generation,
          projectId: p.projectId,
        }
      : {
          kind: p.kind,
          machineId: p.machineId,
          handle: p.handle,
          trust: p.trust,
          controller: p.controller,
          capabilities: {
            messaging: p.capabilities.messaging,
            monitor: p.capabilities.monitor,
            drive: p.capabilities.drive,
          },
        };
  const output: ActivityDecisionTraceV1 = {
    v: 1,
    decidedAt: source.decidedAt,
    facts: {
      v: 1,
      principal: copiedPrincipal,
      tool: source.facts.tool,
      targets: source.facts.targets.map((t) => ({
        sessionId: t.sessionId,
        path: t.path,
        folder: t.folder,
        projectId: t.projectId,
      })),
      masterOn: source.facts.masterOn,
      toYou: source.facts.toYou,
      forceAsk: source.facts.forceAsk,
    },
    decision: source.decision,
    reason: copyReason(source.reason),
    rule: { when: source.rule.when, reach: source.rule.reach, move: source.rule.move },
    forcedAsk: source.forcedAsk,
    assignment:
      source.assignment === null
        ? null
        : {
            point: copyPoint(source.assignment.point),
            profileId: source.assignment.profileId,
            profileName: source.assignment.profileName,
          },
    runtime: { outcome: source.runtime.outcome, code: null },
    stages: [...source.stages],
    ...(source.winnerDigest === undefined ? {} : { winnerDigest: source.winnerDigest }),
    withoutWinner:
      source.withoutWinner === null
        ? null
        : {
            decision: source.withoutWinner.decision,
            reason: copyReason(source.withoutWinner.reason),
          },
  };
  return new TextEncoder().encode(JSON.stringify(output)).length <= 16384 ? output : null;
}

function copyPoint(p: AssignmentPoint): AssignmentPoint {
  switch (p.kind) {
    case 'default':
      return { kind: p.kind };
    case 'session':
      return { kind: p.kind, sessionId: p.sessionId };
    case 'peer':
      return { kind: p.kind, machineId: p.machineId };
    case 'cli':
      return { kind: p.kind, cli: p.cli };
  }
}
function copyReason(r: Reason): Reason {
  switch (r.by) {
    case 'floor':
      return { by: r.by, floor: r.floor };
    case 'deny':
      return { by: r.by, point: copyPoint(r.point) };
    case 'session-deny':
      return { by: r.by, denialId: r.denialId };
    case 'grant':
      return { by: r.by, grantId: r.grantId };
    case 'override':
      return { by: r.by, overrideId: r.overrideId };
    case 'profile':
    case 'exception':
      return { by: r.by, point: copyPoint(r.point), profileId: r.profileId };
  }
}

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
  const trace =
    value.lane === 'conduit' && value.count === null ? parseActivityTrace(value.trace) : null;
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
    ...(trace === null ? {} : { trace }),
  };
}
