// see POL §4-§5
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
  samePath,
  visibleTools as visibleEngine,
} from './policy-engine';
import {
  type PolicyFile,
  parseGrantsFile,
  parsePolicyFile,
  serializeGrantsFile,
  serializePolicyFile,
} from './policy-file';
import { type LegacyPolicy, migrateLegacyPolicy } from './policy-migration';
import { BUILT_IN_PROFILES, pointKey, profileById, WORKER_PROFILE } from './policy-profiles';
import { legacyLowerPoint, projectLegacyLayer, propagateLegacyPatch } from './policy-projection';
import type {
  Assignment,
  AssignmentPoint,
  Grant,
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
  grantsIo: RequestsIo;
  activityIo: ActivityIo;
  now(): number;
  newId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  warn(m: string, e?: unknown): void;
  legacy(): LegacyPolicy;
  launchedCli(sessionId: string): CliKind | null;
  onChanged(): void;
}

export interface PolicyService {
  start(): void;
  stop(): Promise<void>;
  decide(input: Omit<PolicyInput, 'now'>): PolicyDecision;
  commit(decision: PolicyDecision, held?: readonly string[]): OneUseOverride[] | null;
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
}

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
  let grantsWritable = true;
  let policyDirty = false;
  let grantsDirty = false;
  let writeTimer: unknown = null;
  let tickTimer: unknown = null;
  let purgeTimer: unknown = null;
  const pending = new Set<Promise<void>>();
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

  function flush(): Promise<void> {
    const writes: Promise<void>[] = [];
    if (policyDirty && policyWritable) {
      policyDirty = false;
      writes.push(
        save(deps.policyIo, 'policy.json', serializePolicyFile(file), () => {
          policyDirty = true;
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

  // Fail closed: an unreadable file never means an empty policy. The pre-upgrade settings
  // stay in force, read-only, so nothing a user set before the upgrade stops applying.
  function unreadablePolicy(why: string, e?: unknown): void {
    policyWritable = false;
    deps.warn(`${why}; policy is read-only and not saved`, e);
    file = { ...emptyFile(), ...migrateLegacyPolicy(deps.legacy()) };
    activity.record({
      lane: 'note',
      principal: { handle: null, sessionId: null, machineId: null },
      cli: null,
      action: 'policy-unreadable',
      target: null,
      summary: 'Permissions file unreadable; using pre-upgrade settings',
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

  const setPointAssignment = (point: AssignmentPoint, assignment: Assignment | null): void => {
    const key = pointKey(point);
    file.assignments = file.assignments.filter((a) => pointKey(a.point) !== key);
    if (assignment !== null) file.assignments.push({ point, assignment });
    markPolicy();
  };

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

    commit(decision, held = []) {
      // A concurrent call decided on the same override; the first commit spent it. A held id was
      // spent when its card was raised, so it is not checked against the saved list again.
      const heldIds = new Set(held);
      const saved = new Set(file.overrides.map((o) => o.id));
      if (decision.overrideIds.some((id) => !saved.has(id) && !heldIds.has(id))) return null;
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
      if (profileId === null) {
        setPointAssignment(point, null);
      } else {
        const existing = stateNow().assignments.get(pointKey(point));
        setPointAssignment(point, {
          profileId,
          exceptions: existing?.exceptions ?? [],
          onScreenOnly: existing?.onScreenOnly ?? false,
        });
      }
      deps.onChanged();
      return { ok: true };
    },

    applyLegacyPatch(point, lower, tool, patch) {
      if (!policyWritable) return { ok: false, error: 'read-only' };
      const writes = propagateLegacyPatch(stateNow(), point, lower, tool, patch, (sessionId) =>
        deps.launchedCli(sessionId),
      );
      if (writes === null) return { ok: false, error: 'scoped' };
      for (const w of writes) setPointAssignment(w.point, w.assignment);
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
      if (grants.revoke(id) === null) return false;
      markGrants();
      deps.onChanged();
      return true;
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
        const profile = profileById(st, assignment.profileId) ?? WORKER_PROFILE;
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
