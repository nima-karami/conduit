// Node-free: pure text in, text out.
// Unknown fields are kept and written back (SERVER_FILE_VERSION reader rule); a narrowing field needs a version bump.
import { judgePersistedVersion, type ServerFile } from '../contracts/session-identity';
import { GRANT_FORS } from './grant-store';
import { WORKER_PROFILE } from './policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Exception,
  Grant,
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

export interface GrantsFile {
  version: 1;
  grants: Grant[];
}

// A profile may omit tools a newer build added; completeRules fills them from Worker.
type RawProfile = Omit<Profile, 'rules'> & { rules: Partial<Record<ToolName, ToolRule>> };
type RawPolicyFile = Omit<PolicyFile, 'profiles'> & { profiles: RawProfile[] };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
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
  isDecision(v.decision) &&
  isWhenOrNull(v.when) &&
  isReachOrNull(v.reach) &&
  isMoveOrNull(v.move);

const isRules = (v: unknown): v is Partial<Record<ToolName, ToolRule>> =>
  isObj(v) && TOOL_NAMES.every((t) => v[t] === undefined || isToolRule(v[t]));

const isProfile = (v: unknown): v is RawProfile =>
  isObj(v) && isProfileId(v.id) && isStr(v.name) && isBool(v.builtIn) && isRules(v.rules);

const isScope = (v: unknown): v is Scope =>
  isObj(v) &&
  (v.kind === 'anywhere' ||
    (v.kind === 'space' && isStr(v.projectId)) ||
    (v.kind === 'folder' && isStr(v.path)) ||
    (v.kind === 'path' && isStr(v.path)) ||
    (v.kind === 'session' && isStr(v.sessionId)));

const isPartialRule = (v: unknown): v is Partial<ToolRule> =>
  isObj(v) &&
  (v.decision === undefined || isDecision(v.decision)) &&
  (v.when === undefined || isWhenOrNull(v.when)) &&
  (v.reach === undefined || isReachOrNull(v.reach)) &&
  (v.move === undefined || isMoveOrNull(v.move));

const isException = (v: unknown): v is Exception =>
  isObj(v) && isToolName(v.tool) && isScope(v.scope) && isPartialRule(v.rule);

const isAssignment = (v: unknown): v is Assignment =>
  isObj(v) &&
  isProfileId(v.profileId) &&
  arrayOf(isException)(v.exceptions) &&
  isBool(v.onScreenOnly);

const isPoint = (v: unknown): v is AssignmentPoint =>
  isObj(v) &&
  ((v.kind === 'session' && isStr(v.sessionId)) ||
    (v.kind === 'peer' && isStr(v.machineId)) ||
    (v.kind === 'cli' && isCliKind(v.cli)) ||
    v.kind === 'default');

const isAssignmentEntry = (v: unknown): v is PolicyFile['assignments'][number] =>
  isObj(v) && isPoint(v.point) && isAssignment(v.assignment);

const isTarget = (v: unknown): v is PolicyTarget =>
  isObj(v) &&
  orNull(isStr)(v.sessionId) &&
  orNull(isStr)(v.path) &&
  orNull(isStr)(v.folder) &&
  orNull(isStr)(v.projectId);

const isOverride = (v: unknown): v is OneUseOverride =>
  isObj(v) &&
  isStr(v.id) &&
  isStr(v.sessionId) &&
  isToolName(v.tool) &&
  isTarget(v.target) &&
  isIso(v.createdAt);

const isFile = (v: unknown): v is RawPolicyFile =>
  isObj(v) &&
  v.version === 1 &&
  arrayOf(isProfile)(v.profiles) &&
  arrayOf(isAssignmentEntry)(v.assignments) &&
  arrayOf(isOverride)(v.overrides) &&
  (v.migratedFrom === null || v.migratedFrom === 'v0.64') &&
  isObj(v.notes) &&
  arrayOf(isStr)(v.notes.onScreenOnlyOffered);

const GRANT_STATES: readonly GrantState[] = ['active', 'suspended', 'expired', 'revoked'];
const ENDED_STATES: readonly GrantState[] = ['expired', 'revoked'];

const isWho = (v: unknown): v is GrantWho =>
  isObj(v) &&
  ((v.kind === 'session' && isStr(v.sessionId)) ||
    (v.kind === 'cli' && isCliKind(v.cli)) ||
    (v.kind === 'peer' && isStr(v.machineId)));

const isGrant = (v: unknown): v is Grant =>
  isObj(v) &&
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
  (oneOf(ENDED_STATES)(v.state) ? isIso(v.endedAt) : v.endedAt === null) &&
  orNull(isStr)(v.requestId);

const isGrantsFile = (v: unknown): v is GrantsFile =>
  isObj(v) && v.version === 1 && arrayOf(isGrant)(v.grants);

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

// Every tool gets its own copy, so a parsed rule never aliases the built-in Worker profile.
function completeRules(rules: Partial<Record<ToolName, ToolRule>>): Record<ToolName, ToolRule> {
  const out = { ...WORKER_PROFILE.rules };
  for (const tool of TOOL_NAMES) out[tool] = { ...(rules[tool] ?? WORKER_PROFILE.rules[tool]) };
  return out;
}

const completeProfile = (p: RawProfile): Profile => ({ ...p, rules: completeRules(p.rules) });

export function parsePolicyFile(text: string): Parsed<PolicyFile> {
  const parsed = parseVersioned(text, 'conduit-mcp/policy.json', isFile);
  if (!parsed.ok) return parsed;
  const { profiles, ...rest } = parsed.file;
  return { ok: true, file: { ...rest, profiles: profiles.map(completeProfile) } };
}

export function serializePolicyFile(f: PolicyFile): string {
  return toText(f);
}

export function parseGrantsFile(text: string): Parsed<GrantsFile> {
  return parseVersioned(text, 'conduit-mcp/grants.json', isGrantsFile);
}

export function serializeGrantsFile(f: GrantsFile): string {
  return toText(f);
}
