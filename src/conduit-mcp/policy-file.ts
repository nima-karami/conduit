// Node-free: pure text in, text out.
import { judgePersistedVersion, type ServerFile } from '../contracts/session-identity';
import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Exception,
  Grant,
  GrantFor,
  GrantState,
  GrantWho,
  OneUseOverride,
  PolicyTarget,
  Profile,
  ProfileId,
  Scope,
  ToolRule,
} from './policy-types';
import {
  CLI_KINDS,
  type CliKind,
  isToolName,
  MOVE_VALUES,
  REACH_VALUES,
  TOOL_NAMES,
  type ToolName,
  WHEN_VALUES,
} from './tool-policy';

export interface PolicyFile {
  version: 1;
  profiles: Profile[];
  assignments: Array<{ point: AssignmentPoint; assignment: Assignment }>;
  overrides: OneUseOverride[];
  migratedFrom: 'v0.64' | null;
  notes: { onScreenOnlyOffered: string[] };
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const onlyKeys = (v: Obj, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    values.some((x) => x === v);
const orNull =
  <T>(guard: (v: unknown) => v is T) =>
  (v: unknown): v is T | null =>
    v === null || guard(v);
const arrayOf =
  <T>(guard: (v: unknown) => v is T) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every(guard);

const DECISIONS: readonly Decision[] = ['allow', 'ask', 'deny'];
const isDecision = oneOf(DECISIONS);
const isWhenOrNull = orNull(oneOf(WHEN_VALUES));
const isReachOrNull = orNull(oneOf(REACH_VALUES));
const isMoveOrNull = orNull(oneOf(MOVE_VALUES));
const isCliKind = (v: unknown): v is CliKind => oneOf(CLI_KINDS)(v);

const isProfileId = (v: unknown): v is ProfileId =>
  isStr(v) && (v === 'observer' || v === 'worker' || v === 'lead' || v.startsWith('p-'));

const isToolRule = (v: unknown): v is ToolRule =>
  isObj(v) &&
  onlyKeys(v, ['decision', 'when', 'reach', 'move']) &&
  isDecision(v.decision) &&
  isWhenOrNull(v.when) &&
  isReachOrNull(v.reach) &&
  isMoveOrNull(v.move);

const isRules = (v: unknown): v is Record<ToolName, ToolRule> =>
  isObj(v) && onlyKeys(v, TOOL_NAMES) && TOOL_NAMES.every((t) => isToolRule(v[t]));

const isProfile = (v: unknown): v is Profile =>
  isObj(v) &&
  onlyKeys(v, ['id', 'name', 'builtIn', 'rules']) &&
  isProfileId(v.id) &&
  isStr(v.name) &&
  isBool(v.builtIn) &&
  isRules(v.rules);

const isScope = (v: unknown): v is Scope =>
  isObj(v) &&
  ((v.kind === 'anywhere' && onlyKeys(v, ['kind'])) ||
    (v.kind === 'space' && onlyKeys(v, ['kind', 'projectId']) && isStr(v.projectId)) ||
    (v.kind === 'folder' && onlyKeys(v, ['kind', 'path']) && isStr(v.path)) ||
    (v.kind === 'path' && onlyKeys(v, ['kind', 'path']) && isStr(v.path)) ||
    (v.kind === 'session' && onlyKeys(v, ['kind', 'sessionId']) && isStr(v.sessionId)));

const isPartialRule = (v: unknown): v is Partial<ToolRule> =>
  isObj(v) &&
  onlyKeys(v, ['decision', 'when', 'reach', 'move']) &&
  (v.decision === undefined || isDecision(v.decision)) &&
  (v.when === undefined || isWhenOrNull(v.when)) &&
  (v.reach === undefined || isReachOrNull(v.reach)) &&
  (v.move === undefined || isMoveOrNull(v.move));

const isException = (v: unknown): v is Exception =>
  isObj(v) &&
  onlyKeys(v, ['tool', 'scope', 'rule']) &&
  isToolName(v.tool) &&
  isScope(v.scope) &&
  isPartialRule(v.rule);

const isAssignment = (v: unknown): v is Assignment =>
  isObj(v) &&
  onlyKeys(v, ['profileId', 'exceptions', 'onScreenOnly']) &&
  isProfileId(v.profileId) &&
  arrayOf(isException)(v.exceptions) &&
  isBool(v.onScreenOnly);

const isPoint = (v: unknown): v is AssignmentPoint =>
  isObj(v) &&
  ((v.kind === 'session' && onlyKeys(v, ['kind', 'sessionId']) && isStr(v.sessionId)) ||
    (v.kind === 'peer' && onlyKeys(v, ['kind', 'machineId']) && isStr(v.machineId)) ||
    (v.kind === 'cli' && onlyKeys(v, ['kind', 'cli']) && isCliKind(v.cli)) ||
    (v.kind === 'default' && onlyKeys(v, ['kind'])));

const isAssignmentEntry = (v: unknown): v is PolicyFile['assignments'][number] =>
  isObj(v) &&
  onlyKeys(v, ['point', 'assignment']) &&
  isPoint(v.point) &&
  isAssignment(v.assignment);

const isTarget = (v: unknown): v is PolicyTarget =>
  isObj(v) &&
  onlyKeys(v, ['sessionId', 'path', 'projectId']) &&
  orNull(isStr)(v.sessionId) &&
  orNull(isStr)(v.path) &&
  orNull(isStr)(v.projectId);

const isOverride = (v: unknown): v is OneUseOverride =>
  isObj(v) &&
  onlyKeys(v, ['id', 'sessionId', 'tool', 'target', 'createdAt']) &&
  isStr(v.id) &&
  isStr(v.sessionId) &&
  isToolName(v.tool) &&
  isTarget(v.target) &&
  isStr(v.createdAt);

const isFile = (v: unknown): v is PolicyFile =>
  isObj(v) &&
  onlyKeys(v, ['version', 'profiles', 'assignments', 'overrides', 'migratedFrom', 'notes']) &&
  v.version === 1 &&
  arrayOf(isProfile)(v.profiles) &&
  arrayOf(isAssignmentEntry)(v.assignments) &&
  arrayOf(isOverride)(v.overrides) &&
  (v.migratedFrom === null || v.migratedFrom === 'v0.64') &&
  isObj(v.notes) &&
  onlyKeys(v.notes, ['onScreenOnlyOffered']) &&
  arrayOf(isStr)(v.notes.onScreenOnlyOffered);

const GRANT_FORS: readonly GrantFor[] = ['session-end', '1h', '24h', 'until-revoked'];
const GRANT_STATES: readonly GrantState[] = ['active', 'suspended', 'expired', 'revoked'];
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

const isWho = (v: unknown): v is GrantWho =>
  isObj(v) &&
  ((v.kind === 'session' && onlyKeys(v, ['kind', 'sessionId']) && isStr(v.sessionId)) ||
    (v.kind === 'cli' && onlyKeys(v, ['kind', 'cli']) && isCliKind(v.cli)) ||
    (v.kind === 'peer' && onlyKeys(v, ['kind', 'machineId']) && isStr(v.machineId)));

const isGrant = (v: unknown): v is Grant =>
  isObj(v) &&
  onlyKeys(v, [
    'id',
    'who',
    'tool',
    'on',
    'for',
    'anchorSessionId',
    'createdAt',
    'expiresAt',
    'lastUsedAt',
    'state',
    'endedAt',
    'requestId',
  ]) &&
  isStr(v.id) &&
  isWho(v.who) &&
  isToolName(v.tool) &&
  isScope(v.on) &&
  oneOf(GRANT_FORS)(v.for) &&
  orNull(isStr)(v.anchorSessionId) &&
  isIso(v.createdAt) &&
  orNull(isIso)(v.expiresAt) &&
  orNull(isIso)(v.lastUsedAt) &&
  oneOf(GRANT_STATES)(v.state) &&
  orNull(isIso)(v.endedAt) &&
  orNull(isStr)(v.requestId);

const isGrantsFile = (v: unknown): v is GrantsFile =>
  isObj(v) && onlyKeys(v, ['version', 'grants']) && v.version === 1 && arrayOf(isGrant)(v.grants);

type Parsed<T> = { ok: true; file: T } | { ok: false; reason: 'corrupt' | 'newer' };

function parseVersioned<T>(
  text: string,
  file: ServerFile,
  guard: (v: unknown) => v is T,
): Parsed<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (!isObj(raw)) return { ok: false, reason: 'corrupt' };
  const verdict = judgePersistedVersion(file, raw.version);
  if (verdict === 'newer') return { ok: false, reason: 'newer' };
  if (verdict === 'invalid') return { ok: false, reason: 'corrupt' };
  if (!guard(raw)) return { ok: false, reason: 'corrupt' };
  return { ok: true, file: raw };
}

const toText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export function parsePolicyFile(text: string): Parsed<PolicyFile> {
  return parseVersioned(text, 'conduit-mcp/policy.json', isFile);
}

export function serializePolicyFile(f: PolicyFile): string {
  return toText(f);
}

export interface GrantsFile {
  version: 1;
  grants: Grant[];
}

export function parseGrantsFile(text: string): Parsed<GrantsFile> {
  return parseVersioned(text, 'conduit-mcp/grants.json', isGrantsFile);
}

export function serializeGrantsFile(f: GrantsFile): string {
  return toText(f);
}
