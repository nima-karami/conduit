// see POL §4-§5

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
  parsePolicyFile,
  serializeGrantsFile,
  serializePolicyFile,
  validateRemotePolicyDoc,
} from './policy-file';
import { type LegacyPolicy, migrateLegacyPolicy } from './policy-migration';
import { BUILT_IN_PROFILES, OBSERVER, pointKey, profileById } from './policy-profiles';
import { legacyLowerPoint, projectLegacyLayer, propagateLegacyPatch } from './policy-projection';
import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Grant,
  GrantWho,
  OneUseOverride,
  PolicyDecision,
  PolicyInput,
  PolicyState,
  PolicyTarget,
  PolicyUiState,
  Principal,
  ProfileId,
} from './policy-types';
import type { RequestsIo } from './request-file-fs';
import {
  CLI_KINDS,
  type CliKind,
  type CliPolicyLayers,
  type PolicyLayer,
  type ToolName,
  type ToolPolicyPatch,
} from './tool-policy';

export interface PolicyServiceDeps {
  policyIo: RequestsIo;
  lastGoodIo: RequestsIo;
  grantsIo: RequestsIo;
  activityIo: ActivityIo;
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
  ): OneUseOverride[] | null;
  noteDecision(activityId: string, input: Omit<PolicyInput, 'now'>, decision: PolicyDecision): void;
  visibleTools(p: Principal): ToolName[];
  setAssignment(
    point: AssignmentPoint,
    profileId: ProfileId | null,
  ): { ok: true } | { ok: false; error: 'unknown-profile' | 'read-only' };
  applyLegacyPatch(
    point: AssignmentPoint,
    lower: AssignmentPoint | null,
    tool: ToolName,
    patch: ToolPolicyPatch,
  ): { ok: true } | { ok: false; error: 'read-only' | 'scoped' };
  createGrant(
    choice: GrantChoice,
    p: Principal,
    tool: ToolName,
    target: PolicyTarget,
    requestId: string | null,
  ): Grant | null;
  revokeGrant(id: string): boolean;
  peerRevoked(machineId: string): void;
  allowOnce(
    activityId: string,
  ): { ok: true } | { ok: false; error: 'not-found' | 'not-overridable' };
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
  onRemoteDocChange(fn: () => void): () => void;
  applyRemoteDoc(baseRev: number, doc: unknown, machineId: string): RemoteApplyResult;
  grantsView(): RemoteGrantView[];
  revokeGrantByRemote(
    grantId: string,
    machineId: string,
  ): { ok: true } | { ok: false; code: 'not_found'; message: string };
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
  version: 1,
  profiles: [],
  assignments: [],
  overrides: [],
  migratedFrom: null,
  notes: { onScreenOnlyOffered: [] },
});

export function createPolicyService(deps: PolicyServiceDeps): PolicyService {
  let file: PolicyFile = emptyFile();
  let policyWritable = true;
  let failClosed = false;
  let grantsWritable = true;
  let policyDirty = false;
  let lastGoodDirty = false;
  let grantsDirty = false;
  let writeTimer: unknown = null;
  let tickTimer: unknown = null;
  let purgeTimer: unknown = null;
  const pending = new Set<Promise<void>>();
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

  const assignmentMap = (): Map<string, Assignment> =>
    new Map(file.assignments.map((a) => [pointKey(a.point), a.assignment]));

  const stateNow = (): PolicyState => ({
    profiles: file.profiles,
    assignments: assignmentMap(),
    grants: grants.all(),
    overrides: file.overrides,
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
    if (!policyWritable) return;
    policyDirty = true;
    scheduleWrite();
  };

  const markGrants = (): void => {
    if (!grantsWritable) return;
    grantsDirty = true;
    scheduleWrite();
  };

  // One warning per outage per file: a disk that stays down is retried without spamming the log.
  const outages = new Set<string>();

  async function save(io: RequestsIo, name: string, text: string, redo: () => void): Promise<void> {
    try {
      await io.write(text);
      outages.delete(name);
    } catch (e) {
      redo();
      if (!outages.has(name)) {
        outages.add(name);
        deps.warn(`${name} could not be saved; will retry`, e);
      }
    }
  }

  // A load writes the copy at once: a timer here would hold the server's first write window open.
  function writeLastGood(): void {
    if (!policyWritable) return;
    const w = save(deps.lastGoodIo, 'policy.last-good.json', serializePolicyFile(file), () => {
      lastGoodDirty = true;
      scheduleWrite();
    });
    pending.add(w);
    void w.then(() => pending.delete(w));
  }

  function flush(): Promise<void> {
    const writes: Promise<void>[] = [];
    if (policyDirty && policyWritable) {
      policyDirty = false;
      lastGoodDirty = true;
      writes.push(
        save(deps.policyIo, 'policy.json', serializePolicyFile(file), () => {
          policyDirty = true;
          scheduleWrite();
        }),
      );
    }
    if (lastGoodDirty && policyWritable) {
      lastGoodDirty = false;
      writes.push(
        save(deps.lastGoodIo, 'policy.last-good.json', serializePolicyFile(file), () => {
          lastGoodDirty = true;
          scheduleWrite();
        }),
      );
    }
    if (grantsDirty && grantsWritable) {
      grantsDirty = false;
      writes.push(
        save(
          deps.grantsIo,
          'grants.json',
          serializeGrantsFile({ version: 1, grants: grants.all() }),
          () => {
            grantsDirty = true;
            scheduleWrite();
          },
        ),
      );
    }
    for (const w of writes) {
      pending.add(w);
      void w.then(() => pending.delete(w));
    }
    return Promise.all(writes).then(() => undefined);
  }

  // Only `absent` may migrate from legacy: a copy that exists but can't be used is a fault to
  // fail closed on, never a reason to rebuild the policy from the old settings.
  type LastGoodFault = 'unreadable' | 'newer' | 'read-failed';
  type LastGood =
    | { kind: 'absent' }
    | { kind: 'ok'; policy: PolicyFile }
    | { kind: 'bad'; reason: LastGoodFault };
  const LAST_GOOD_FAULT_TEXT: Record<LastGoodFault, string> = {
    unreadable: 'is unreadable',
    newer: 'is from a newer version',
    'read-failed': 'could not be read',
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
    const parsed = parsePolicyFile(text);
    if (!parsed.ok) {
      deps.warn(
        parsed.reason === 'newer'
          ? 'policy.last-good.json is from a newer version'
          : 'policy.last-good.json is unreadable',
      );
      return { kind: 'bad', reason: parsed.reason === 'newer' ? 'newer' : 'unreadable' };
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
      markGrants();
      deps.onChanged();
    }
    activity.flushCounts(false);
    tickTimer = deps.setTimer(tick, TICK_MS);
  };

  const purge = (): void => {
    if (stopped) return;
    activity.purge();
    purgeTimer = deps.setTimer(purge, PURGE_MS);
  };

  // Returns true only when a portable (non-session) point changed: that is what bumps rev.
  const setPointAssignment = (point: AssignmentPoint, assignment: Assignment | null): boolean => {
    const key = pointKey(point);
    const before = file.assignments.find((a) => pointKey(a.point) === key)?.assignment ?? null;
    if (JSON.stringify(before) === JSON.stringify(assignment)) return false;
    file.assignments = file.assignments.filter((a) => pointKey(a.point) !== key);
    if (assignment !== null) file.assignments.push({ point, assignment });
    markPolicy();
    return point.kind !== 'session';
  };

  const currentRev = (): number => file.rev ?? 0;

  // rev is the owner's copy version: a controller's push names the rev it edited, and B refuses
  // a push built on any other one. Listeners run after the rev has moved, so they read the new doc.
  const bumpRev = (): void => {
    file.rev = currentRev() + 1;
    for (const fn of remoteListeners) fn();
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

  const revokeGrantById = (id: string): boolean => {
    if (grants.revoke(id) === null) return false;
    markGrants();
    deps.onChanged();
    return true;
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
      loadPolicy();
      loadGrants();
      tickTimer = deps.setTimer(tick, TICK_MS);
      purgeTimer = deps.setTimer(purge, PURGE_MS);
    },

    async stop() {
      stopped = true;
      if (tickTimer !== null) deps.clearTimer(tickTimer);
      if (purgeTimer !== null) deps.clearTimer(purgeTimer);
      if (writeTimer !== null) deps.clearTimer(writeTimer);
      tickTimer = null;
      purgeTimer = null;
      writeTimer = null;
      activity.flushCounts(true);
      await flush();
      await Promise.all(pending);
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
      if (decision.overrideIds.some((id) => !saved.has(id) && !heldIds.has(id))) return null;
      // A grant revoked or expired, or an exception added, while the call waited refuses it.
      const now = deps.now();
      const live = new Set(
        grants
          .all()
          .filter((g) => isLiveGrant(g, now))
          .map((g) => g.id),
      );
      if (decision.grantIds.some((id) => !live.has(id))) return null;
      const fresh = decideEngine(stateNow(), { ...input, heldOverrides: held, now });
      if (DECISION_RANK[fresh.decision] < DECISION_RANK[decision.decision]) return null;
      if (decision.grantIds.length > 0) {
        for (const id of decision.grantIds) grants.touch(id);
        markGrants();
      }
      const used = new Set(decision.overrideIds.filter((id) => !heldIds.has(id)));
      const removed = file.overrides.filter((o) => used.has(o.id));
      if (removed.length > 0) {
        file.overrides = file.overrides.filter((o) => !used.has(o.id));
        markPolicy();
        deps.onChanged();
      }
      return removed;
    },

    noteDecision(activityId, input, decision) {
      if (decision.reason.by !== 'deny' || input.principal.kind !== 'session') return;
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

    visibleTools(p) {
      return visibleEngine(stateNow(), p, deps.now());
    },

    legacyLowerPoint(launchedCli) {
      return legacyLowerPoint(stateNow(), launchedCli);
    },

    profileName(id) {
      return profileById(stateNow(), id)?.name ?? null;
    },

    setAssignment(point, profileId) {
      if (profileId !== null && profileById(stateNow(), profileId) === null) {
        return { ok: false, error: 'unknown-profile' };
      }
      if (!policyWritable) return { ok: false, error: 'read-only' };
      let portable: boolean;
      if (profileId === null) {
        portable = setPointAssignment(point, null);
      } else {
        const existing = stateNow().assignments.get(pointKey(point));
        portable = setPointAssignment(point, {
          profileId,
          exceptions: existing?.exceptions ?? [],
          onScreenOnly: existing?.onScreenOnly ?? false,
          ...(existing?.pinned === undefined ? {} : { pinned: existing.pinned }),
        });
      }
      if (portable) bumpRev();
      deps.onChanged();
      return { ok: true };
    },

    applyLegacyPatch(point, lower, tool, patch) {
      if (!policyWritable) return { ok: false, error: 'read-only' };
      const writes = propagateLegacyPatch(stateNow(), point, lower, tool, patch, (sessionId) =>
        deps.launchedCli(sessionId),
      );
      if (writes === null) return { ok: false, error: 'scoped' };
      let portable = false;
      for (const w of writes) {
        if (setPointAssignment(w.point, w.assignment)) portable = true;
      }
      if (portable) bumpRev();
      deps.onChanged();
      return { ok: true };
    },

    createGrant(choice, p, tool, target, requestId) {
      const who = grantWhoFor(choice.who, p);
      const on = grantScopeFor(choice.on, target, p);
      if (who === null || on === null) return null;
      const anchor = choice.for === 'session-end' && p.kind === 'session' ? p.sessionId : null;
      const created = grants.create(who, tool, on, choice.for, anchor, requestId);
      markGrants();
      deps.onChanged();
      return created;
    },

    peerRevoked(machineId) {
      if (grants.peerRevoked(machineId).length === 0) return;
      markGrants();
      deps.onChanged();
    },

    revokeGrant(id) {
      return revokeGrantById(id);
    },

    remoteDoc() {
      return remoteSnapshot();
    },

    onRemoteDocChange(fn) {
      remoteListeners.add(fn);
      return () => {
        remoteListeners.delete(fn);
      };
    },

    applyRemoteDoc(baseRev, doc, _machineId) {
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
      // Session assignments name this machine's own sessions, so they never travel and never change.
      const local = file.assignments.filter((a) => a.point.kind === 'session');
      file.profiles = checked.doc.profiles;
      file.assignments = [...local, ...checked.doc.assignments];
      bumpRev();
      markPolicy();
      deps.onChanged();
      return { ok: true, rev: currentRev() };
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

    // machineId names the owner that asked; it is for the revoke audit, which waits on the audit-sink decision (plan L2).
    revokeGrantByRemote(grantId, _machineId) {
      if (revokeGrantById(grantId)) return { ok: true };
      return { ok: false, code: 'not_found', message: 'no live grant with that id' };
    },

    allowOnce(activityId) {
      const rem = remembered.get(activityId);
      if (rem === undefined && spent.has(activityId)) return { ok: false, error: 'not-found' };
      if (rem === undefined) {
        return activity.recentDenies().has(activityId)
          ? { ok: false, error: 'not-overridable' }
          : { ok: false, error: 'not-found' };
      }
      remembered.delete(activityId);
      spent.add(activityId);
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
        file.overrides = [
          ...file.overrides,
          {
            id: deps.newId(),
            sessionId: rem.sessionId,
            tool: rem.tool,
            target: rem.target,
            createdAt: new Date(deps.now()).toISOString(),
          },
        ];
        markPolicy();
        deps.onChanged();
      }
      return { ok: true };
    },

    sessionEnded(sessionId) {
      const assignments = file.assignments.length;
      const overrides = file.overrides.length;
      file.assignments = file.assignments.filter(
        (a) => pointKey(a.point) !== pointKey({ kind: 'session', sessionId }),
      );
      file.overrides = file.overrides.filter((o) => o.sessionId !== sessionId);
      for (const [id, rem] of remembered) {
        if (rem.sessionId === sessionId) remembered.delete(id);
      }
      const policyChanged =
        file.assignments.length !== assignments || file.overrides.length !== overrides;
      if (policyChanged) markPolicy();
      const endedGrants = grants.sessionEnded(sessionId);
      if (endedGrants.length > 0) markGrants();
      if (policyChanged || endedGrants.length > 0) deps.onChanged();
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
        profiles: [...BUILT_IN_PROFILES, ...st.profiles].map((p) => ({
          id: p.id,
          name: p.name,
          builtIn: p.builtIn,
        })),
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
