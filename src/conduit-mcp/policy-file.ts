// Node-free: pure text in, text out.
// Unknown fields are kept and written back (SERVER_FILE_VERSION reader rule); a narrowing field needs a version bump.
import { parseNativeModes } from '../contracts/native-launch';
import {
  REMOTE_POLICY_ASSIGNMENTS_MAX,
  REMOTE_POLICY_DOC_MAX_BYTES,
  REMOTE_POLICY_EXCEPTIONS_MAX,
  REMOTE_POLICY_NAME_MAX,
  REMOTE_POLICY_PATH_MAX,
  REMOTE_POLICY_PROFILES_MAX,
  type RemotePolicyDoc,
  type RemotePolicyPoint,
} from '../contracts/remote-policy';
import { judgePersistedVersion, type ServerFile } from '../contracts/session-identity';
import { printableName } from '../network/addresses';
import { GRANT_FORS } from './grant-store';
import { supportsNativePoint } from './policy-native';
import { BUILT_IN_PROFILES, OBSERVER, pointKey } from './policy-profiles';
import { withPinned } from './policy-projection';
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
  SessionDenial,
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
  version: 1 | 2 | 3;
  /** Bumped on every change to the portable projection (see policy-service). A missing rev reads as 0. */
  rev?: number;
  profiles: Profile[];
  assignments: Array<{ point: AssignmentPoint; assignment: Assignment }>;
  overrides: OneUseOverride[];
  sessionDenials?: SessionDenial[];
  migratedFrom: 'v0.64' | null;
  notes: { onScreenOnlyOffered: string[] };
}

export interface GrantsFile {
  version: 1;
  grants: Grant[];
}

// A profile may omit tools a newer build added; completeRules fills them from Observer.
type RawProfile = Omit<Profile, 'rules'> & { rules: Partial<Record<ToolName, ToolRule>> };
type RawPolicyFile = Omit<PolicyFile, 'profiles'> & { profiles: RawProfile[] };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRev = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
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
  isObj(v) &&
  isProfileId(v.id) &&
  isStr(v.name) &&
  isBool(v.builtIn) &&
  isRules(v.rules) &&
  (v.nativeModes === undefined || parseNativeModes(v.nativeModes) !== null);

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

// pinned is additive: an older build drops it, which only lets those sessions follow the default again.
const isAssignment = (v: unknown): v is Assignment =>
  isObj(v) &&
  isProfileId(v.profileId) &&
  arrayOf(isException)(v.exceptions) &&
  isBool(v.onScreenOnly) &&
  (v.pinned === undefined || arrayOf(isStr)(v.pinned)) &&
  (v.applyNative === undefined || isBool(v.applyNative));

const isPoint = (v: unknown): v is AssignmentPoint =>
  isObj(v) &&
  ((v.kind === 'session' && isStr(v.sessionId)) ||
    (v.kind === 'peer' && isStr(v.machineId)) ||
    (v.kind === 'cli' && isCliKind(v.cli)) ||
    v.kind === 'default');

const isAssignmentEntry = (v: unknown): v is PolicyFile['assignments'][number] =>
  isObj(v) &&
  isPoint(v.point) &&
  isAssignment(v.assignment) &&
  (v.assignment.applyNative !== true || supportsNativePoint(v.point));

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

export const SESSION_DENIALS_MAX = 4096;
const isSessionDenial = (v: unknown): v is SessionDenial =>
  isObj(v) &&
  isStr(v.id) &&
  isStr(v.requestId) &&
  isStr(v.sessionId) &&
  isToolName(v.tool) &&
  isIso(v.createdAt) &&
  new Date(v.createdAt).toISOString() === v.createdAt;

const isFile = (v: unknown): v is RawPolicyFile =>
  isObj(v) &&
  (v.version === 1 || v.version === 2 || v.version === 3) &&
  !(v.version === 3 && v.kind === 'recovery-unavailable') &&
  (v.rev === undefined || isRev(v.rev)) &&
  arrayOf(isProfile)(v.profiles) &&
  new Set(v.profiles.map((p) => p.id)).size === v.profiles.length &&
  arrayOf(isAssignmentEntry)(v.assignments) &&
  (v.version !== 1 ||
    (v.profiles.every((p) => !('nativeModes' in p)) &&
      v.assignments.every((a) => !('applyNative' in a.assignment)))) &&
  arrayOf(isOverride)(v.overrides) &&
  (v.version !== 3 ||
    (arrayOf(isSessionDenial)(v.sessionDenials) &&
      v.sessionDenials.length <= SESSION_DENIALS_MAX &&
      new Set(v.sessionDenials.map((d) => d.requestId)).size === v.sessionDenials.length &&
      new Set(v.sessionDenials.map((d) => d.id)).size === v.sessionDenials.length)) &&
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
  const out = { ...OBSERVER.rules };
  for (const tool of TOOL_NAMES) out[tool] = { ...(rules[tool] ?? OBSERVER.rules[tool]) };
  return out;
}

const completeProfile = (p: RawProfile): Profile => ({
  ...p,
  ...(p.nativeModes && {
    nativeModes: { claude: p.nativeModes.claude, codex: p.nativeModes.codex },
  }),
  rules: completeRules(p.rules),
});

// Pins sit on non-default points only, sorted and unique (see plan third-pass rulings); a hand-edited file is brought to that shape.
const normaliseEntry = (
  e: PolicyFile['assignments'][number],
): PolicyFile['assignments'][number] => ({
  point: e.point,
  assignment: withPinned(
    e.assignment,
    e.point.kind === 'default' ? [] : (e.assignment.pinned ?? []),
  ),
});

export function parsePolicyFile(text: string): Parsed<PolicyFile> {
  const parsed = parseVersioned(text, 'conduit-mcp/policy.json', isFile);
  if (!parsed.ok) return parsed;
  const { profiles, assignments, ...rest } = parsed.file;
  return {
    ok: true,
    file: {
      ...rest,
      sessionDenials: parsed.file.version === 3 ? parsed.file.sessionDenials : [],
      assignments: assignments.map(normaliseEntry),
      profiles: profiles.map(completeProfile),
    },
  };
}

export function parsePolicyBackup(
  text: string,
):
  | { kind: 'policy'; file: PolicyFile }
  | { kind: 'recovery-unavailable' }
  | { kind: 'bad'; reason: 'corrupt' | 'newer' } {
  try {
    const raw: unknown = JSON.parse(text);
    if (
      isObj(raw) &&
      raw.version === 3 &&
      raw.kind === 'recovery-unavailable' &&
      Object.keys(raw).length === 2
    )
      return { kind: 'recovery-unavailable' };
  } catch {
    /* parsed below */
  }
  const result = parsePolicyFile(text);
  return result.ok ? { kind: 'policy', file: result.file } : { kind: 'bad', reason: result.reason };
}

export function serializePolicyFile(f: PolicyFile): string {
  return toText({ ...f, version: f.version === 3 ? 3 : 2 });
}

export function parseGrantsFile(text: string): Parsed<GrantsFile> {
  return parseVersioned(text, 'conduit-mcp/grants.json', isGrantsFile);
}

export type RemoteDocCheck = { ok: true; doc: RemotePolicyDoc } | { ok: false; message: string };

const refuse = (message: string): RemoteDocCheck => ({ ok: false, message });
const isRemotePoint = (p: AssignmentPoint): p is RemotePolicyPoint => p.kind !== 'session';

// The machine that owns the rules enforces the caps; a controller's push is never trusted to have.
// Each refusal names the first failing path, so a rejected push says where it went wrong.
export function validateRemotePolicyDoc(v: unknown): RemoteDocCheck {
  if (!isObj(v)) return refuse('doc is not an object');
  if (new TextEncoder().encode(JSON.stringify(v)).length > REMOTE_POLICY_DOC_MAX_BYTES)
    return refuse(`doc too large (over ${REMOTE_POLICY_DOC_MAX_BYTES} bytes)`);
  if (!Array.isArray(v.profiles)) return refuse('profiles is not a list');
  if (v.profiles.length > REMOTE_POLICY_PROFILES_MAX)
    return refuse(`profiles has more than ${REMOTE_POLICY_PROFILES_MAX} entries`);

  const profiles: Profile[] = [];
  const seenProfiles = new Map<string, number>();
  for (const [i, raw] of v.profiles.entries()) {
    const at = `profiles[${i}]`;
    if (!isProfile(raw)) return refuse(`${at} is malformed`);
    // Built-in profiles come from policy-profiles on every machine; a pushed copy would only shadow them.
    if (!raw.id.startsWith('p-')) return refuse(`${at}.id is not a custom profile id`);
    const first = seenProfiles.get(raw.id);
    if (first !== undefined) return refuse(`${at}.id duplicates profiles[${first}].id`);
    seenProfiles.set(raw.id, i);
    if (raw.name.length > REMOTE_POLICY_NAME_MAX) return refuse(`${at}.name too long`);
    if (!printableName(raw.name, REMOTE_POLICY_NAME_MAX))
      return refuse(raw.name.trim() === '' ? `${at}.name empty` : `${at}.name not printable`);
    profiles.push(completeProfile(raw));
  }

  if (!Array.isArray(v.assignments)) return refuse('assignments is not a list');
  if (v.assignments.length > REMOTE_POLICY_ASSIGNMENTS_MAX)
    return refuse(`assignments has more than ${REMOTE_POLICY_ASSIGNMENTS_MAX} entries`);

  const known = new Set<string>([
    ...BUILT_IN_PROFILES.map((p) => p.id),
    ...profiles.map((p) => p.id),
  ]);
  const seenPoints = new Map<string, number>();
  const assignments: RemotePolicyDoc['assignments'] = [];
  for (const [i, raw] of v.assignments.entries()) {
    const at = `assignments[${i}]`;
    if (!isAssignmentEntry(raw)) return refuse(`${at} is malformed`);
    const point = raw.point;
    if (!isRemotePoint(point)) return refuse(`${at}.point is a session point`);
    const { assignment } = normaliseEntry(raw);
    if (assignment.exceptions.length > REMOTE_POLICY_EXCEPTIONS_MAX)
      return refuse(
        `${at}.assignment.exceptions has more than ${REMOTE_POLICY_EXCEPTIONS_MAX} entries`,
      );
    for (const [j, ex] of assignment.exceptions.entries()) {
      const scope = ex.scope;
      // A session id names one B-local session; it has no meaning on any other machine.
      if (scope.kind === 'session')
        return refuse(`${at}.assignment.exceptions[${j}].scope is session-kind`);
      if (
        (scope.kind === 'folder' || scope.kind === 'path') &&
        scope.path.length > REMOTE_POLICY_PATH_MAX
      )
        return refuse(`${at}.assignment.exceptions[${j}].scope.path too long`);
    }
    if (!known.has(assignment.profileId)) return refuse(`${at}.assignment.profileId unknown`);
    const key = pointKey(point);
    const first = seenPoints.get(key);
    if (first !== undefined) return refuse(`${at}.point duplicates assignments[${first}].point`);
    seenPoints.set(key, i);
    assignments.push({ point, assignment });
  }
  return { ok: true, doc: { profiles, assignments } };
}

export function serializeGrantsFile(f: GrantsFile): string {
  return toText(f);
}

export function validatePolicyAssignment(
  point: unknown,
  assignment: unknown,
): PolicyFile['assignments'][number] | null {
  const entry = { point, assignment };
  if (!isAssignmentEntry(entry)) return null;
  if (entry.assignment.exceptions.length > REMOTE_POLICY_EXCEPTIONS_MAX) return null;
  for (const exception of entry.assignment.exceptions) {
    const scope = exception.scope;
    if (
      (scope.kind === 'path' || scope.kind === 'folder') &&
      scope.path.length > REMOTE_POLICY_PATH_MAX
    )
      return null;
  }
  try {
    JSON.stringify({ point, assignment });
    return structuredClone(normaliseEntry(entry));
  } catch {
    return null;
  }
}

export function validatePolicyProfile(raw: unknown): Profile | null {
  if (
    !isProfile(raw) ||
    !raw.id.startsWith('p-') ||
    raw.id.length < 3 ||
    raw.builtIn ||
    !printableName(raw.name, REMOTE_POLICY_NAME_MAX) ||
    !TOOL_NAMES.every((tool) => isToolRule(raw.rules[tool]))
  )
    return null;
  try {
    JSON.stringify(raw);
    return structuredClone(completeProfile(raw));
  } catch {
    return null;
  }
}
