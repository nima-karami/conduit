// see POL §4-§5

import type { NativeFamily, NativeSelection } from '../contracts/native-launch';
import type { RemoteGrantView, RemotePolicyDoc } from '../contracts/remote-policy';
import { type ActivityIo, type ActivityLog, createActivityLog } from './activity-log';
import {
  createGrantStore,
  type GrantChoice,
  grantScopeFor,
  grantWhoFor,
  isExpiring,
} from './grant-store';
import {
  assignmentFor,
  decide as decideEngine,
  isLiveGrant,
  samePath,
  visibleTools as visibleEngine,
} from './policy-engine';
import {
  type PolicyFile,
  parseGrantsFile,
  parsePolicyBackup,
  parsePolicyFile,
  SESSION_DENIALS_MAX,
  serializeGrantsFile,
  serializePolicyFile,
  validatePolicyAssignment,
  validatePolicyProfile,
  validateRemotePolicyDoc,
} from './policy-file';
import { POLICY_MAX_BYTES, type PolicyIo } from './policy-file-fs';
import { type LegacyPolicy, migrateLegacyPolicy } from './policy-migration';
import { assignmentMap, nativeProjection, selectNative } from './policy-native';
import { BUILT_IN_PROFILES, OBSERVER, pointKey, profileById } from './policy-profiles';
import { legacyLowerPoint, projectLegacyLayer, propagateLegacyPatch } from './policy-projection';
import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Grant,
  GrantBatchResult,
  GrantWho,
  OneUseOverride,
  PolicyCommitResult,
  PolicyDecision,
  PolicyEditResult,
  PolicyInput,
  PolicyState,
  PolicyTarget,
  PolicyUiState,
  Principal,
  Profile,
  ProfileId,
} from './policy-types';
import {
  CLI_KINDS,
  type CliKind,
  type CliPolicyLayers,
  type PolicyLayer,
  type ToolName,
  type ToolPolicyPatch,
} from './tool-policy';

export interface PolicyServiceDeps {
  policyIo: PolicyIo;
  lastGoodIo: PolicyIo;
  grantsIo: PolicyIo;
  activityIo: ActivityIo;
  hasSession(id: string): boolean;
  peerKnown(id: string): boolean | null;
  now(): number;
  newId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  warn(m: string, e?: unknown): void;
  legacy(): LegacyPolicy;
  launchedCli(sessionId: string): CliKind | null | undefined;
  onChanged(): void;
}

export type RemoteApplyResult =
  | { ok: true; rev: number }
  | {
      ok: false;
      code: 'policy_conflict' | 'invalid_args' | 'policy_unavailable';
      message: string;
      current?: { rev: number; doc: RemotePolicyDoc };
    };

export interface PolicyService {
  start(): void;
  stop(): Promise<void>;
  decide(input: Omit<PolicyInput, 'now'>): PolicyDecision;
  commit(
    input: Omit<PolicyInput, 'now'>,
    decision: PolicyDecision,
    held?: readonly OneUseOverride[],
  ): PolicyCommitResult;
  noteDecision(activityId: string, input: Omit<PolicyInput, 'now'>, decision: PolicyDecision): void;
  visibleTools(p: Principal): ToolName[];
  nativeLaunch(sessionId: string, family: NativeFamily): NativeSelection;
  nativeLaunchSelections(
    sessions: readonly { id: string; family: NativeFamily }[],
  ): Map<string, NativeSelection>;
  setAssignment(point: AssignmentPoint, profileId: ProfileId | null): PolicyEditResult;
  applyLegacyPatch(
    point: AssignmentPoint,
    lower: AssignmentPoint | null,
    tool: ToolName,
    patch: ToolPolicyPatch,
  ): PolicyEditResult | { ok: false; error: 'scoped' };
  createGrant(
    choice: GrantChoice,
    p: Principal,
    tool: ToolName,
    target: PolicyTarget,
    requestId: string | null,
  ): Grant | null;
  createGrants(
    choice: GrantChoice,
    p: Principal,
    tool: ToolName,
    targets: readonly PolicyTarget[],
    requestId: string | null,
  ): GrantBatchResult;
  revokeGrant(id: string): PolicyEditResult;
  revokeGrants(ids: readonly string[]): PolicyEditResult;
  reconcilePrincipals(): void;
  saveAssignment(
    point: AssignmentPoint,
    assignment: Assignment | null,
    expectedToken: string,
    nativeConsent?: boolean,
  ): PolicyEditResult;
  saveProfile(profile: Profile, expectedToken: string, nativeConsent?: boolean): PolicyEditResult;
  deleteProfile(
    profileId: ProfileId,
    replacement: ProfileId,
    expectedToken: string,
    nativeConsent?: boolean,
  ): PolicyEditResult;
  retrySave(): PolicyEditResult;
  peerRevoked(machineId: string): void;
  allowOnce(activityId: string): PolicyEditResult | { ok: false; error: 'not-overridable' };
  saveSessionDenial(
    requestId: string,
    sessionId: string,
    tool: ToolName,
    beforeNotify: () => void,
  ): PolicyEditResult;
  sessionEnded(sessionId: string): void;
  readonly activity: ActivityLog;
  ui(
    sessions: ReadonlyArray<{
      sessionId: string;
      launchedCli: CliKind | null;
    }>,
  ): PolicyUiState;
  legacyLowerPoint(launchedCli: CliKind | null): AssignmentPoint;
  profileName(id: ProfileId): string | null;
  /** The portable projection: human-made profiles and non-session assignments, at the current rev. */
  remoteDoc(): { rev: number; doc: RemotePolicyDoc };
  /** Fires when anything a controller snapshot carries changes: the rules (rev moves) or the grants. */
  onRemoteDocChange(fn: () => void): () => void;
  applyRemoteDoc(baseRev: number, doc: unknown, senderSupportsNative: boolean): RemoteApplyResult;
  grantsView(): RemoteGrantView[];
  revokeGrantByRemote(
    grantId: string,
  ): { ok: true } | { ok: false; code: 'not_found' | 'policy_unavailable'; message: string };
}

const DECISION_RANK: Record<Decision, number> = { deny: 0, ask: 1, allow: 2 };
const WRITE_COALESCE_MS = 250;
const TICK_MS = 60_000;
const PURGE_MS = 3_600_000;
const REMEMBERED_DENIES = 200;

interface Remembered {
  sessionId: string;
  tool: ToolName;
  target: PolicyTarget;
}

const emptyFile = (): PolicyFile => ({
  version: 2,
  profiles: [],
  assignments: [],
  overrides: [],
  migratedFrom: null,
  notes: { onScreenOnlyOffered: [] },
});

export function createPolicyService(deps: PolicyServiceDeps): PolicyService {
  let file: PolicyFile = emptyFile();
  let policyWritable = true;
  let policyLoaded = false;
  let failClosed = false;
  let grantsWritable = true;
  let policyDirty = false;
  let grantsDirty = false;
  let writeTimer: unknown = null;
  let tickTimer: unknown = null;
  let purgeTimer: unknown = null;
  let pendingConservativePolicy = false;
  let pendingConservativeGrants = false;
  let conservativeRetryTimer: unknown = null;
  let conservativeRetryAttempts = 0;
  let editToken = '';
  let backupWarning: string | null = null;
  const saveErrors = new Map<'policy' | 'grants', string>();
  const remoteListeners = new Set<() => void>();
  const remembered = new Map<string, Remembered>();
  const spent = new Set<string>();

  const activity: ActivityLog = createActivityLog({
    io: deps.activityIo,
    now: () => deps.now(),
    newId: () => deps.newId(),
    warn: deps.warn,
  });
  const grants = createGrantStore({ now: () => deps.now(), newId: () => deps.newId() });

  const stateNow = (): PolicyState => ({
    profiles: file.profiles,
    assignments: assignmentMap(file.assignments),
    grants: grants.all(),
    overrides: file.overrides,
    sessionDenials: file.sessionDenials ?? [],
    failClosed,
  });

  let stopped = false;

  const scheduleWrite = (): void => {
    if (stopped || writeTimer !== null) return;
    writeTimer = deps.setTimer(() => {
      writeTimer = null;
      void flush();
    }, WRITE_COALESCE_MS);
  };

  const markPolicy = (): void => {
    if (!policyWritable || saveErrors.has('policy')) return;
    policyDirty = true;
    scheduleWrite();
  };

  const markGrants = (): void => {
    if (!grantsWritable || saveErrors.has('grants')) return;
    grantsDirty = true;
    scheduleWrite();
  };

  const notifyRemote = (): void => {
    for (const fn of remoteListeners) fn();
  };

  function writePrimary(io: PolicyIo, kind: 'policy' | 'grants', text: string): PolicyEditResult {
    if (Buffer.byteLength(text) > POLICY_MAX_BYTES) {
      saveErrors.set(kind, `${kind} store is too large to save`);
      return { ok: false, error: 'too-large' };
    }
    try {
      if (io.writeSync(text) !== true)
        throw new Error('Policy writer did not complete synchronously');
      saveErrors.delete(kind);
      return { ok: true };
    } catch (error) {
      saveErrors.set(kind, `${kind} could not be saved`);
      deps.warn(`${kind}.json could not be saved; retry explicitly`, error);
      return { ok: false, error: 'save-failed' };
    }
  }

  function writeLastGood(notifyFailure = true): void {
    if (!policyWritable) return;
    try {
      const text = serializePolicyFile(file);
      if (Buffer.byteLength(text) > POLICY_MAX_BYTES) throw new Error('Backup is too large');
      if (deps.lastGoodIo.writeSync(text) !== true)
        throw new Error('Backup writer did not complete synchronously');
      backupWarning = null;
    } catch (error) {
      backupWarning = 'Permissions were saved, but their backup could not be saved';
      deps.warn(backupWarning, error);
      if (notifyFailure) deps.onChanged();
    }
  }

  const scheduleConservativeRetry = (): void => {
    if (!pendingConservativePolicy && !pendingConservativeGrants) {
      if (conservativeRetryTimer !== null) deps.clearTimer(conservativeRetryTimer);
      conservativeRetryTimer = null;
      conservativeRetryAttempts = 0;
      return;
    }
    if (
      stopped ||
      conservativeRetryTimer !== null ||
      conservativeRetryAttempts >= 3 ||
      !(
        (pendingConservativePolicy && policyWritable) ||
        (pendingConservativeGrants && grantsWritable)
      )
    )
      return;
    const delay = [250, 1000, 5000][conservativeRetryAttempts++];
    conservativeRetryTimer = deps.setTimer(() => {
      conservativeRetryTimer = null;
      flush(true);
    }, delay);
  };

  function savePolicy(
    candidate: PolicyFile,
    portable: boolean,
    conservative = false,
    beforeNotify?: () => void,
  ): PolicyEditResult {
    if (!policyWritable && !conservative) return { ok: false, error: 'read-only' };
    const assignmentsChanged =
      JSON.stringify([file.profiles, file.assignments]) !==
      JSON.stringify([candidate.profiles, candidate.assignments]);
    candidate = structuredClone(candidate);
    if (portable) candidate.rev = (file.rev ?? 0) + 1;
    policyDirty = false;
    const result: PolicyEditResult = policyWritable
      ? writePrimary(deps.policyIo, 'policy', serializePolicyFile(candidate))
      : { ok: false, error: 'read-only' };
    if (!result.ok && !conservative) {
      deps.onChanged();
      return result;
    }
    if (!result.ok) candidate.rev = file.rev;
    file = candidate;
    if (assignmentsChanged) editToken = deps.newId();
    if (result.ok) {
      pendingConservativePolicy = false;
      writeLastGood(beforeNotify === undefined);
    } else {
      pendingConservativePolicy = true;
      saveErrors.set('policy', 'Restrictions are active here; policy could not be saved');
    }
    try {
      beforeNotify?.();
    } finally {
      scheduleConservativeRetry();
      if (portable) notifyRemote();
      deps.onChanged();
    }
    return result.ok ? result : { ...result, applied: 'tightening' };
  }

  function saveGrants(candidate: Grant[], conservative = false): PolicyEditResult {
    if (!grantsWritable && !conservative) return { ok: false, error: 'read-only' };
    grantsDirty = false;
    const result: PolicyEditResult = grantsWritable
      ? writePrimary(
          deps.grantsIo,
          'grants',
          serializeGrantsFile({ version: 1, grants: candidate }),
        )
      : { ok: false, error: 'read-only' };
    if (!result.ok && !conservative) {
      deps.onChanged();
      return result;
    }
    grants.load(candidate);
    if (result.ok) pendingConservativeGrants = false;
    else {
      pendingConservativeGrants = true;
      saveErrors.set('grants', 'Restrictions are active here; grants could not be saved');
    }
    scheduleConservativeRetry();
    notifyRemote();
    deps.onChanged();
    return result.ok ? result : { ...result, applied: 'tightening' };
  }

  function flush(force = false): void {
    if (
      policyWritable &&
      ((force && pendingConservativePolicy) || (policyDirty && !saveErrors.has('policy')))
    )
      savePolicy(file, false, true);
    if (
      grantsWritable &&
      ((force && pendingConservativeGrants) || (grantsDirty && !saveErrors.has('grants')))
    )
      saveGrants(grants.all(), true);
  }

  const grantCandidate = () => {
    const next = createGrantStore({ now: deps.now, newId: deps.newId });
    next.load(grants.all());
    return next;
  };

  const reconcilePrincipals = (): void => {
    const next = grantCandidate();
    next.tick();
    const candidate = next.all();
    for (const grant of candidate) {
      if (grant.state !== 'active' && grant.state !== 'suspended') continue;
      const peerGone = grant.who.kind === 'peer' && deps.peerKnown(grant.who.machineId) === false;
      const sessionGone =
        (grant.who.kind === 'session' && !deps.hasSession(grant.who.sessionId)) ||
        (grant.on.kind === 'session' && !deps.hasSession(grant.on.sessionId)) ||
        (grant.for === 'session-end' &&
          grant.anchorSessionId !== null &&
          !deps.hasSession(grant.anchorSessionId));
      if (peerGone || sessionGone) {
        grant.state = peerGone ? 'revoked' : 'expired';
        grant.endedAt = new Date(deps.now()).toISOString();
      }
    }
    if (JSON.stringify(candidate) !== JSON.stringify(grants.all())) saveGrants(candidate, true);
  };

  const grantsChanged = (): void => {
    saveGrants(grants.all(), true);
  };

  // Only `absent` may migrate from legacy: a copy that exists but can't be used is a fault to
  // fail closed on, never a reason to rebuild the policy from the old settings.
  type LastGoodFault = 'unreadable' | 'newer' | 'read-failed' | 'recovery-unavailable';
  type LastGood =
    | { kind: 'absent' }
    | { kind: 'ok'; policy: PolicyFile }
    | { kind: 'bad'; reason: LastGoodFault };
  const LAST_GOOD_FAULT_TEXT: Record<LastGoodFault, string> = {
    unreadable: 'is unreadable',
    newer: 'is from a newer version',
    'read-failed': 'could not be read',
    'recovery-unavailable': 'is unavailable after a permissions save',
  };

  function readLastGood(): LastGood {
    let text: string | null;
    try {
      text = deps.lastGoodIo.read();
    } catch (e) {
      deps.warn('policy.last-good.json could not be read', e);
      return { kind: 'bad', reason: 'read-failed' };
    }
    if (text === null) return { kind: 'absent' };
    const parsed = parsePolicyBackup(text);
    if (parsed.kind === 'recovery-unavailable') {
      deps.warn('policy.last-good.json recovery is unavailable after a permissions save');
      return { kind: 'bad', reason: 'recovery-unavailable' };
    }
    if (parsed.kind === 'bad') {
      const reason = parsed.reason;
      deps.warn(
        reason === 'newer'
          ? 'policy.last-good.json is from a newer version'
          : 'policy.last-good.json is unreadable',
      );
      return { kind: 'bad', reason: reason === 'newer' ? 'newer' : 'unreadable' };
    }
    return { kind: 'ok', policy: parsed.file };
  }

  // Fail closed: an unreadable file never means an empty or a widened policy. The last copy
  // this server read or wrote stays in force, read-only; with none, every session is Observer.
  // `lost` is set when policy.json is missing and the saved copy is the reason we failed closed.
  function unreadablePolicy(why: string, e?: unknown, lost?: LastGoodFault): void {
    policyWritable = false;
    deps.warn(`${why}; policy is read-only and not saved`, e);
    const good = readLastGood();
    const usable = good.kind === 'ok' ? good.policy : null;
    failClosed = usable === null;
    file = usable ?? {
      ...emptyFile(),
      assignments: [
        {
          point: { kind: 'default' },
          assignment: { profileId: 'observer', exceptions: [], onScreenOnly: false },
        },
      ],
    };
    activity.record({
      lane: 'note',
      principal: { handle: null, sessionId: null, machineId: null },
      cli: null,
      action: 'policy-unreadable',
      target: null,
      summary:
        usable !== null
          ? 'Permissions file unreadable; using the last saved copy'
          : lost !== undefined
            ? `Permissions file missing and its saved copy ${LAST_GOOD_FAULT_TEXT[lost]}; every session is Observer`
            : 'Permissions file unreadable and no saved copy; every session is Observer',
      decision: null,
      decidedBy: 'conduit',
      outcome: null,
      durationMs: null,
      requestId: null,
      count: null,
    });
  }

  function loadPolicy(): void {
    let text: string | null;
    try {
      text = deps.policyIo.read();
    } catch (e) {
      unreadablePolicy('policy.json could not be read', e);
      return;
    }
    if (text === null) {
      // A lost policy.json is rebuilt from the last saved copy; legacy settings only seed a first run.
      const good = readLastGood();
      if (good.kind === 'ok') {
        file = good.policy;
        markPolicy();
        return;
      }
      if (good.kind === 'bad') {
        unreadablePolicy(
          'policy.json is missing and the saved copy is unusable',
          undefined,
          good.reason,
        );
        return;
      }
      const migrated = migrateLegacyPolicy(deps.legacy());
      file = { ...emptyFile(), ...migrated };
      for (const a of migrated.assignments) {
        if (a.point.kind !== 'cli') continue;
        activity.record({
          lane: 'note',
          principal: { handle: null, sessionId: null, machineId: null },
          cli: a.point.cli,
          action: 'migration',
          target: null,
          summary: `kind rule for ${a.point.cli} now applies only to sessions Conduit launched`,
          decision: null,
          decidedBy: 'conduit',
          outcome: null,
          durationMs: null,
          requestId: null,
          count: null,
        });
      }
      markPolicy();
      return;
    }
    const parsed = parsePolicyFile(text);
    if (!parsed.ok) {
      unreadablePolicy(
        parsed.reason === 'newer'
          ? 'policy.json is from a newer version'
          : 'policy.json is unreadable',
      );
      return;
    }
    file = parsed.file;
    writeLastGood();
  }

  function loadGrants(): void {
    let text: string | null;
    try {
      text = deps.grantsIo.read();
    } catch (e) {
      grantsWritable = false;
      deps.warn('grants.json could not be read; grants are not saved', e);
      return;
    }
    if (text === null) return;
    const parsed = parseGrantsFile(text);
    if (!parsed.ok) {
      grantsWritable = false;
      deps.warn(
        parsed.reason === 'newer'
          ? 'grants.json is from a newer version; grants are read-only and not saved'
          : 'grants.json is unreadable; grants are read-only and not saved',
      );
      return;
    }
    grants.load(parsed.file.grants);
  }

  const tick = (): void => {
    if (stopped) return;
    const expired = grants.tick();
    if (expired.length > 0) {
      grantsChanged();
    }
    activity.flushCounts(false);
    tickTimer = deps.setTimer(tick, TICK_MS);
  };

  const purge = (): void => {
    if (stopped) return;
    activity.purge();
    purgeTimer = deps.setTimer(purge, PURGE_MS);
  };

  const setPointAssignment = (
    candidate: PolicyFile,
    point: AssignmentPoint,
    assignment: Assignment | null,
  ): boolean => {
    const key = pointKey(point);
    const before = candidate.assignments.find((a) => pointKey(a.point) === key)?.assignment ?? null;
    if (JSON.stringify(before) === JSON.stringify(assignment)) return false;
    candidate.assignments = candidate.assignments.filter((a) => pointKey(a.point) !== key);
    if (assignment !== null)
      candidate.assignments.push({
        point: structuredClone(point),
        assignment: structuredClone(assignment),
      });
    return point.kind !== 'session';
  };
  const currentRev = (): number => file.rev ?? 0;

  const validateCandidate = (candidate: PolicyFile): PolicyEditResult => {
    const parsed = parsePolicyFile(serializePolicyFile(candidate));
    if (!parsed.ok) return { ok: false, error: 'invalid-value' };
    const known = new Set([...BUILT_IN_PROFILES, ...candidate.profiles].map((p) => p.id));
    if (candidate.assignments.some((a) => !known.has(a.assignment.profileId)))
      return { ok: false, error: 'unknown-profile' };
    return { ok: true };
  };

  const saveReviewedPolicy = (
    candidate: PolicyFile,
    portable: boolean,
    nativeConsent?: boolean,
  ): PolicyEditResult => {
    if (!policyWritable) return { ok: false, error: 'read-only' };
    if (nativeConsent !== true && nativeProjection(candidate) !== nativeProjection(file))
      return { ok: false, error: 'native-review-required' };
    return savePolicy(candidate, portable);
  };

  const saveAssignment = (
    point: AssignmentPoint,
    assignment: Assignment | null,
    expectedToken: string,
    nativeConsent?: boolean,
  ): PolicyEditResult => {
    if (expectedToken !== editToken) return { ok: false, error: 'conflict' };
    if (!policyWritable) return { ok: false, error: 'read-only' };
    let checked: Assignment | null = null;
    if (assignment !== null) {
      const entry = validatePolicyAssignment(point, assignment);
      if (entry === null) return { ok: false, error: 'invalid-value' };
      checked = entry.assignment;
    } else if (
      !validatePolicyAssignment(point, { profileId: 'worker', exceptions: [], onScreenOnly: false })
    )
      return { ok: false, error: 'invalid-value' };
    const candidate = structuredClone(file);
    const portable = setPointAssignment(candidate, point, checked);
    const valid = validateCandidate(candidate);
    return valid.ok ? saveReviewedPolicy(candidate, portable, nativeConsent) : valid;
  };

  const revokeGrants = (ids: readonly string[]): PolicyEditResult => {
    const candidate = grantCandidate();
    for (const id of new Set(ids)) candidate.revoke(id);
    return saveGrants(candidate.all(), true);
  };

  const createGrants = (
    choice: GrantChoice,
    p: Principal,
    tool: ToolName,
    targets: readonly PolicyTarget[],
    requestId: string | null,
  ): GrantBatchResult => {
    const who = grantWhoFor(choice.who, p);
    const scopes = targets.map((target) => grantScopeFor(choice.on, target, p));
    if (who === null || scopes.length === 0 || scopes.some((scope) => scope === null))
      return { ok: false, error: 'invalid-value' };
    const candidate = grantCandidate();
    const anchor = choice.for === 'session-end' && p.kind === 'session' ? p.sessionId : null;
    const made: Grant[] = [];
    for (const scope of scopes) {
      if (scope === null) return { ok: false, error: 'invalid-value' };
      made.push(candidate.create(who, tool, scope, choice.for, anchor, requestId));
    }
    try {
      const result = saveGrants(candidate.all());
      return result.ok ? { ok: true, grants: made } : result;
    } catch (error) {
      try {
        revokeGrants(made.map((grant) => grant.id));
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Grant publication and rollback both failed',
        );
      }
      throw error;
    }
  };

  const remoteSnapshot = (): { rev: number; doc: RemotePolicyDoc } => ({
    rev: currentRev(),
    doc: {
      profiles: structuredClone(file.profiles),
      assignments: structuredClone(
        file.assignments.flatMap((a) =>
          a.point.kind === 'session' ? [] : [{ point: a.point, assignment: a.assignment }],
        ),
      ),
    },
  });

  const revokeGrantById = (id: string): PolicyEditResult => {
    const candidate = grantCandidate();
    if (candidate.revoke(id) === null) return { ok: false, error: 'not-found' };
    return saveGrants(candidate.all(), true);
  };

  // A peer's who is text for the controller's screen; the grant keeps the typed value.
  const whoText = (who: GrantWho): string =>
    who.kind === 'session'
      ? `session ${who.sessionId}`
      : who.kind === 'cli'
        ? `${who.cli} CLI`
        : who.machineId;

  return {
    activity,

    start() {
      editToken = deps.newId();
      loadPolicy();
      policyLoaded = true;
      loadGrants();
      reconcilePrincipals();
      tickTimer = deps.setTimer(tick, TICK_MS);
      purgeTimer = deps.setTimer(purge, PURGE_MS);
    },

    async stop() {
      stopped = true;
      if (tickTimer !== null) deps.clearTimer(tickTimer);
      if (purgeTimer !== null) deps.clearTimer(purgeTimer);
      if (writeTimer !== null) deps.clearTimer(writeTimer);
      if (conservativeRetryTimer !== null) deps.clearTimer(conservativeRetryTimer);
      conservativeRetryTimer = null;
      tickTimer = null;
      purgeTimer = null;
      writeTimer = null;
      activity.flushCounts(true);
      flush(true);
    },

    decide(input) {
      return decideEngine(stateNow(), { ...input, now: deps.now() });
    },

    commit(input, decision, held = []) {
      // A concurrent call decided on the same override; the first commit spent it. A held
      // override was spent when its card was raised, so it is not checked against the saved
      // list again.
      const heldIds = new Set(held.map((o) => o.id));
      const saved = new Set(file.overrides.map((o) => o.id));
      if (decision.overrideIds.some((id) => !saved.has(id) && !heldIds.has(id)))
        return { ok: false, error: 'policy-changed' };
      // A grant revoked or expired, or an exception added, while the call waited refuses it.
      const now = deps.now();
      const live = new Set(
        grants
          .all()
          .filter((g) => isLiveGrant(g, now))
          .map((g) => g.id),
      );
      if (decision.grantIds.some((id) => !live.has(id)))
        return { ok: false, error: 'policy-changed' };
      const fresh = decideEngine(stateNow(), { ...input, heldOverrides: held, now });
      if (DECISION_RANK[fresh.decision] < DECISION_RANK[decision.decision])
        return { ok: false, error: 'policy-changed' };
      if (decision.grantIds.length > 0) {
        for (const id of decision.grantIds) grants.touch(id);
        markGrants();
      }
      const used = new Set(decision.overrideIds.filter((id) => !heldIds.has(id)));
      const removed = file.overrides.filter((o) => used.has(o.id));
      if (removed.length > 0) {
        const candidate = structuredClone(file);
        candidate.overrides = candidate.overrides.filter((o) => !used.has(o.id));
        const saved = savePolicy(candidate, false, true);
        if (!saved.ok) {
          if (
            saved.error === 'save-failed' ||
            saved.error === 'too-large' ||
            saved.error === 'read-only'
          )
            return { ok: false, error: saved.error };
          throw new Error(`Unexpected conservative save failure: ${saved.error}`);
        }
      }
      return { ok: true, overrides: removed };
    },

    noteDecision(activityId, input, decision) {
      if (
        (decision.reason.by !== 'deny' && decision.reason.by !== 'session-deny') ||
        input.principal.kind !== 'session'
      )
        return;
      if (decision.deniedTarget === null) return;
      const principal = input.principal;
      remembered.set(activityId, {
        sessionId: principal.sessionId,
        tool: input.tool,
        target: decision.deniedTarget,
      });
      if (remembered.size > REMEMBERED_DENIES) {
        const oldest = remembered.keys().next().value;
        if (oldest !== undefined) remembered.delete(oldest);
      }
    },

    nativeLaunch(sessionId, family) {
      return policyLoaded && policyWritable
        ? selectNative(stateNow(), sessionId, family)
        : { status: 'unavailable' };
    },

    nativeLaunchSelections(sessions) {
      const state = policyLoaded && policyWritable ? stateNow() : null;
      return new Map(
        sessions.map(({ id, family }) => [
          id,
          state ? selectNative(state, id, family) : { status: 'unavailable' },
        ]),
      );
    },

    visibleTools(p) {
      return visibleEngine(stateNow(), p, deps.now());
    },

    legacyLowerPoint(launchedCli) {
      return legacyLowerPoint(stateNow(), launchedCli);
    },

    profileName(id) {
      return profileById(stateNow(), id)?.name ?? null;
    },

    saveAssignment,

    saveProfile(profile, expectedToken, nativeConsent) {
      if (expectedToken !== editToken) return { ok: false, error: 'conflict' };
      const checked = validatePolicyProfile(profile);
      if (checked === null) return { ok: false, error: 'invalid-value' };
      const candidate = structuredClone(file);
      candidate.profiles = [...candidate.profiles.filter((p) => p.id !== checked.id), checked];
      const valid = validateCandidate(candidate);
      return valid.ok ? saveReviewedPolicy(candidate, true, nativeConsent) : valid;
    },

    deleteProfile(profileId, replacement, expectedToken, nativeConsent) {
      if (expectedToken !== editToken) return { ok: false, error: 'conflict' };
      if (
        BUILT_IN_PROFILES.some((p) => p.id === profileId) ||
        !file.profiles.some((p) => p.id === profileId) ||
        profileId === replacement ||
        !profileById(stateNow(), replacement)
      )
        return { ok: false, error: 'unknown-profile' };
      const candidate = structuredClone(file);
      candidate.profiles = candidate.profiles.filter((p) => p.id !== profileId);
      for (const entry of candidate.assignments)
        if (entry.assignment.profileId === profileId) entry.assignment.profileId = replacement;
      const valid = validateCandidate(candidate);
      return valid.ok ? saveReviewedPolicy(candidate, true, nativeConsent) : valid;
    },

    retrySave() {
      const policy = savePolicy(file, false, true);
      const grant = saveGrants(grants.all(), true);
      return policy.ok ? grant : policy;
    },

    setAssignment(point, profileId) {
      if (profileId !== null && profileById(stateNow(), profileId) === null)
        return { ok: false, error: 'unknown-profile' };
      const existing = stateNow().assignments.get(pointKey(point));
      return saveAssignment(
        point,
        profileId === null
          ? null
          : {
              profileId,
              exceptions: existing?.exceptions ?? [],
              onScreenOnly: existing?.onScreenOnly ?? false,
              ...(existing?.pinned === undefined ? {} : { pinned: existing.pinned }),
              ...(existing?.applyNative === undefined ? {} : { applyNative: existing.applyNative }),
            },
        editToken,
      );
    },

    applyLegacyPatch(point, lower, tool, patch) {
      if (!policyWritable) return { ok: false, error: 'read-only' };
      const writes = propagateLegacyPatch(stateNow(), point, lower, tool, patch, (sessionId) =>
        deps.launchedCli(sessionId),
      );
      if (writes === null) return { ok: false, error: 'scoped' };
      const candidate = structuredClone(file);
      let portable = false;
      for (const w of writes)
        if (setPointAssignment(candidate, w.point, w.assignment)) portable = true;
      return saveReviewedPolicy(candidate, portable);
    },

    createGrants,
    createGrant(choice, p, tool, target, requestId) {
      const result = createGrants(choice, p, tool, [target], requestId);
      return result.ok ? (result.grants[0] ?? null) : null;
    },

    peerRevoked(machineId) {
      if (grants.peerRevoked(machineId).length === 0) return;
      grantsChanged();
    },

    revokeGrant(id) {
      return revokeGrantById(id);
    },

    revokeGrants,

    reconcilePrincipals,

    remoteDoc() {
      return remoteSnapshot();
    },

    onRemoteDocChange(fn) {
      remoteListeners.add(fn);
      return () => {
        remoteListeners.delete(fn);
      };
    },

    applyRemoteDoc(baseRev, doc, senderSupportsNative) {
      if (!policyWritable)
        return {
          ok: false,
          code: 'policy_unavailable',
          message: 'rules are read-only on this machine',
        };
      if (!Number.isInteger(baseRev) || baseRev < 0)
        return { ok: false, code: 'invalid_args', message: 'baseRev is not a whole number' };
      const checked = validateRemotePolicyDoc(doc);
      if (!checked.ok) return { ok: false, code: 'invalid_args', message: checked.message };
      if (baseRev !== currentRev())
        return {
          ok: false,
          code: 'policy_conflict',
          message: `rules are at rev ${currentRev()}, not ${baseRev}`,
          current: remoteSnapshot(),
        };
      const candidate = structuredClone(file);
      const local = candidate.assignments.filter((a) => a.point.kind === 'session');
      candidate.profiles = checked.doc.profiles;
      candidate.assignments = [...local, ...checked.doc.assignments];
      const candidateState = { ...stateNow(), profiles: candidate.profiles };
      if (
        local.some(
          ({ assignment }) =>
            assignment.applyNative === true && !profileById(candidateState, assignment.profileId),
        )
      )
        return {
          ok: false,
          code: 'policy_unavailable',
          message:
            'A local session uses a removed native profile. Change that assignment on this machine first.',
        };
      if (!senderSupportsNative && nativeProjection(candidate) !== nativeProjection(file))
        return {
          ok: false,
          code: 'policy_unavailable',
          message: 'Update the controller and review the native launch changes before sending.',
        };
      const result = savePolicy(candidate, true);
      return result.ok
        ? { ok: true, rev: currentRev() }
        : { ok: false, code: 'policy_unavailable', message: result.error };
    },

    grantsView() {
      const now = deps.now();
      return grants
        .all()
        .filter((g) => isLiveGrant(g, now))
        .map((g) => ({
          id: g.id,
          tool: g.tool,
          who: whoText(g.who),
          on: { ...g.on },
          for: g.for,
          createdAt: g.createdAt,
          expiresAt: g.expiresAt,
          lastUsedAt: g.lastUsedAt,
        }));
    },

    revokeGrantByRemote(grantId) {
      const result = revokeGrantById(grantId);
      return result.ok
        ? result
        : {
            ok: false,
            code: result.error === 'not-found' ? 'not_found' : 'policy_unavailable',
            message: result.error,
          };
    },

    allowOnce(activityId) {
      const rem = remembered.get(activityId);
      if (rem === undefined && spent.has(activityId)) return { ok: false, error: 'not-found' };
      if (rem === undefined) {
        return activity.recentDenies().has(activityId)
          ? { ok: false, error: 'not-overridable' }
          : { ok: false, error: 'not-found' };
      }
      const markSpent = () => {
        remembered.delete(activityId);
        spent.add(activityId);
      };
      if (spent.size > REMEMBERED_DENIES) {
        const oldest = spent.values().next().value;
        if (oldest !== undefined) spent.delete(oldest);
      }
      const duplicate = file.overrides.some(
        (o) =>
          o.sessionId === rem.sessionId &&
          o.tool === rem.tool &&
          o.target.sessionId === rem.target.sessionId &&
          samePath(o.target.path, rem.target.path),
      );
      if (!duplicate) {
        const candidate = structuredClone(file);
        candidate.overrides = [
          ...candidate.overrides,
          {
            id: deps.newId(),
            sessionId: rem.sessionId,
            tool: rem.tool,
            target: rem.target,
            createdAt: new Date(deps.now()).toISOString(),
          },
        ];
        const result = savePolicy(candidate, false);
        if (!result.ok) return result;
      }
      markSpent();
      return { ok: true };
    },

    saveSessionDenial(requestId, sessionId, tool, beforeNotify) {
      if (!policyWritable) return { ok: false, error: 'read-only' };
      const existing = (file.sessionDenials ?? []).find((d) => d.requestId === requestId);
      if (existing) {
        if (existing.sessionId !== sessionId || existing.tool !== tool)
          return { ok: false, error: 'invalid-value' };
        beforeNotify();
        return { ok: true };
      }
      if ((file.sessionDenials ?? []).length >= SESSION_DENIALS_MAX)
        return { ok: false, error: 'too-large' };
      const candidate = structuredClone(file);
      candidate.version = 3;
      candidate.sessionDenials = [
        ...(candidate.sessionDenials ?? []),
        {
          id: deps.newId(),
          requestId,
          sessionId,
          tool,
          createdAt: new Date(deps.now()).toISOString(),
        },
      ];
      if (Buffer.byteLength(serializePolicyFile(candidate)) > POLICY_MAX_BYTES)
        return { ok: false, error: 'too-large' };
      try {
        if (
          deps.lastGoodIo.writeSync(
            JSON.stringify({ version: 3, kind: 'recovery-unavailable' }),
          ) !== true
        )
          throw new Error('Marker writer did not complete synchronously');
      } catch (error) {
        deps.warn('Policy recovery marker could not be saved', error);
        return { ok: false, error: 'save-failed' };
      }
      return savePolicy(candidate, false, false, beforeNotify);
    },

    sessionEnded(sessionId) {
      const assignments = file.assignments.length;
      const overrides = file.overrides.length;
      const denials = (file.sessionDenials ?? []).length;
      const candidate = structuredClone(file);
      candidate.assignments = candidate.assignments.filter(
        (a) => pointKey(a.point) !== pointKey({ kind: 'session', sessionId }),
      );
      candidate.overrides = candidate.overrides.filter((o) => o.sessionId !== sessionId);
      candidate.sessionDenials = (candidate.sessionDenials ?? []).filter(
        (d) => d.sessionId !== sessionId,
      );
      for (const [id, rem] of remembered) {
        if (rem.sessionId === sessionId) remembered.delete(id);
      }
      const policyChanged =
        candidate.assignments.length !== assignments ||
        candidate.overrides.length !== overrides ||
        candidate.sessionDenials.length !== denials;
      if (policyChanged) savePolicy(candidate, false, true);
      const endedGrants = grants.sessionEnded(sessionId);
      if (endedGrants.length > 0) grantsChanged();
    },

    ui(sessions) {
      const st = stateNow();
      const now = deps.now();
      const sessionRows: PolicyUiState['sessions'] = {};
      const sessionLegacy: Record<string, PolicyLayer> = {};
      for (const row of sessions) {
        const principal: Principal = {
          kind: 'session',
          sessionId: row.sessionId,
          handle: '',
          launchedCli: row.launchedCli,
          homeFolder: null,
          projectId: null,
        };
        const { point, assignment } = assignmentFor(st, principal);
        const profile = profileById(st, assignment.profileId) ?? OBSERVER;
        const exceptions = assignment.exceptions.length + (assignment.onScreenOnly ? 1 : 0);
        const source =
          point.kind === 'session' ? 'session' : point.kind === 'cli' ? 'cli' : 'default';
        const isPlain =
          source === 'default' && assignment.profileId === 'worker' && exceptions === 0;
        sessionRows[row.sessionId] = {
          profileId: assignment.profileId,
          profileName: profile.name,
          exceptions,
          source,
          label: isPlain ? null : `${profile.name}${exceptions ? ` +${exceptions}` : ''}`,
        };
        sessionLegacy[row.sessionId] = projectLegacyLayer(
          st,
          { kind: 'session', sessionId: row.sessionId },
          legacyLowerPoint(st, row.launchedCli),
        );
      }
      const byCli: CliPolicyLayers = {};
      for (const cli of CLI_KINDS) {
        byCli[cli] = projectLegacyLayer(st, { kind: 'cli', cli }, { kind: 'default' });
      }
      return {
        editToken,
        saveError: [...saveErrors.values()].join('; ') || null,
        backupWarning,
        profiles: structuredClone([...BUILT_IN_PROFILES, ...st.profiles]),
        assignments: structuredClone(file.assignments),
        sessions: sessionRows,
        grants: st.grants.map((g) => ({ ...g, expiring: isExpiring(g, now) })),
        legacy: {
          global: projectLegacyLayer(st, { kind: 'default' }, null),
          byCli,
          sessions: sessionLegacy,
        },
        readOnly: !policyWritable || !grantsWritable,
      };
    },
  };
}
