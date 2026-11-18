// Precedence is POL §4.3: floors, explicit denies, grants, then the most specific assignment.
import type { Capability } from '../contracts/remote-principal';
import { folderKey } from '../folder-key';
import {
  effectiveRule,
  matchesScope,
  OBSERVER,
  pointKey,
  profileById,
  resolveTarget,
  STRICTNESS,
} from './policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Exception,
  FloorId,
  Grant,
  GrantWho,
  OneUseOverride,
  PolicyDecision,
  PolicyInput,
  PolicyState,
  PolicyTarget,
  Principal,
  Profile,
  ProfileId,
  Reason,
  Scope,
  ToolRule,
} from './policy-types';
import { type CliKind, TOOL_NAMES, type ToolName } from './tool-policy';

// see NET §4.1 (R21) and spec 2026-11-16-remote-ssh §4.4
// The machine tools are local to each side, so no remote holds 'fleet': a controller can drive our
// sessions, but never reshape or read our fleet of links.
const CAPABILITY_OF: Record<ToolName, Capability | 'orchestrate' | 'fleet'> = {
  list_machines: 'fleet',
  connect_machine: 'fleet',
  disconnect_machine: 'fleet',
  list_sessions: 'messaging',
  send_message: 'messaging',
  read_inbox: 'messaging',
  read_attachment: 'messaging',
  request_input: 'messaging',
  wait_request: 'messaging',
  withdraw_request: 'messaging',
  list_requests: 'messaging',
  list_agents: 'monitor',
  wait_sessions: 'monitor',
  open_file: 'drive',
  close_files: 'drive',
  open_review: 'drive',
  open_diff: 'drive',
  open_git_history: 'drive',
  open_url: 'drive',
  focus_session: 'drive',
  attach_folder: 'drive',
  open_session: 'orchestrate',
  open_terminal: 'orchestrate',
  close_session: 'orchestrate',
  send_input: 'orchestrate',
  read_screen: 'orchestrate',
};

// see NET §4.1 (R21)
const ORCHESTRATE_ASK: readonly ToolName[] = [
  'open_session',
  'open_terminal',
  'close_session',
  'send_input',
  'read_screen',
];
const OWN_PEER_ASSIGNMENT: Assignment = {
  profileId: 'worker',
  exceptions: ORCHESTRATE_ASK.map((tool) => ({
    tool,
    scope: { kind: 'anywhere' },
    rule: { decision: 'ask' },
  })),
  onScreenOnly: false,
};
const DEFAULT_ASSIGNMENT: Assignment = {
  profileId: 'worker',
  exceptions: [],
  onScreenOnly: false,
};
// see docs/plans/2026-11-16-remote-ssh-routed-tools.plan.md, decision 2: the controller is the lead
const CONTROLLER_ASSIGNMENT: Assignment = {
  profileId: 'lead',
  exceptions: [],
  onScreenOnly: false,
};
const ALLOW: Decision = 'allow';
const FLOOR_TEXT: Record<FloorId, string> = {
  'master-off': 'Conduit tools are off',
  'remote-capability': 'not allowed on this link',
  'local-to-you': 'always allowed to you',
};

const EMPTY_TARGET: PolicyTarget = {
  sessionId: null,
  path: null,
  folder: null,
  projectId: null,
};

function resolveTargets(targets: readonly PolicyTarget[], principal: Principal): PolicyTarget[] {
  const list = targets.length === 0 ? [EMPTY_TARGET] : targets;
  return list.map((t) => resolveTarget(t, principal));
}

export const samePath = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : folderKey(a) === folderKey(b);

// see NET §4.1 (R21): orchestrate is never a capability a TLS peer holds, only the ssh controller
function remoteAllows(principal: Extract<Principal, { kind: 'remote' }>, tool: ToolName): boolean {
  const cap = CAPABILITY_OF[tool];
  if (cap === 'fleet') return false;
  return cap === 'orchestrate' ? principal.controller : principal.capabilities[cap];
}

function forPrincipal(principal: Principal, rule: ToolRule): ToolRule {
  if (principal.kind === 'session') return rule;
  return {
    ...rule,
    when: rule.when === null ? null : 'always',
    reach: rule.reach === 'window' ? 'opened' : rule.reach,
  };
}

export function isLiveGrant(g: Grant, now: number): boolean {
  return g.state === 'active' && (g.expiresAt === null || Date.parse(g.expiresAt) > now);
}

function whoMatches(who: GrantWho, p: Principal): boolean {
  switch (who.kind) {
    case 'session':
      return p.kind === 'session' && p.sessionId === who.sessionId;
    case 'cli':
      return p.kind === 'session' && p.launchedCli !== null && p.launchedCli === who.cli;
    case 'peer':
      return p.kind === 'remote' && p.machineId === who.machineId;
  }
}

function done(
  decision: Decision,
  reason: Reason,
  rule: ToolRule,
  grantIds: readonly string[] = [],
  overrideIds: readonly string[] = [],
  deniedTarget: PolicyTarget | null = null,
): PolicyDecision {
  return {
    decision,
    reason,
    rule: { when: rule.when, reach: rule.reach, move: rule.move },
    grantId: reason.by === 'grant' ? (grantIds[0] ?? null) : null,
    grantIds,
    overrideId: reason.by === 'override' ? (overrideIds[0] ?? null) : null,
    overrideIds,
    deniedTarget,
    forcedAsk: false,
  };
}

const OBSERVER_ASSIGNMENT: Assignment = {
  profileId: 'observer',
  exceptions: [],
  onScreenOnly: false,
};

export function assignmentFor(
  state: PolicyState,
  p: Principal,
  omitSession = false,
): { point: AssignmentPoint; assignment: Assignment } {
  if (state.failClosed) return { point: { kind: 'default' }, assignment: OBSERVER_ASSIGNMENT };
  if (p.kind === 'remote') {
    const point: AssignmentPoint = { kind: 'peer', machineId: p.machineId };
    const stored = state.assignments.get(pointKey(point));
    if (stored) return { point, assignment: stored };
    return {
      point,
      assignment: p.controller ? CONTROLLER_ASSIGNMENT : OWN_PEER_ASSIGNMENT,
    };
  }
  const candidates: AssignmentPoint[] = omitSession
    ? []
    : [{ kind: 'session', sessionId: p.sessionId }];
  if (p.launchedCli !== null) candidates.push({ kind: 'cli', cli: p.launchedCli });
  candidates.push({ kind: 'default' });
  for (const point of candidates) {
    const assignment = state.assignments.get(pointKey(point));
    if (assignment) return { point, assignment };
  }
  return { point: { kind: 'default' }, assignment: DEFAULT_ASSIGNMENT };
}

function normalizedScope(scope: Scope): Scope {
  return scope.kind === 'folder' || scope.kind === 'path'
    ? { kind: scope.kind, path: folderKey(scope.path) }
    : { ...scope };
}

type DenyWinner =
  | {
      kind: 'exception';
      point: AssignmentPoint;
      index: number;
      exception: Exception;
      scope: Scope;
      rule: ToolRule;
    }
  | { kind: 'session-deny'; denialId: string };
type DecisionStage = 'floors' | 'explicit-deny' | 'grants' | 'assignment';
interface TraceRecorder {
  stages: DecisionStage[];
  winner: DenyWinner | null;
}

export function decide(state: PolicyState, input: PolicyInput): PolicyDecision {
  return evaluate(state, input);
}

export function decideWithTrace(
  state: PolicyState,
  input: PolicyInput,
): {
  decision: PolicyDecision;
  trace: {
    stages: DecisionStage[];
    winner: DenyWinner | null;
    withoutWinner: Pick<PolicyDecision, 'decision' | 'reason'> | null;
  };
} {
  const recorder: TraceRecorder = { stages: [], winner: null };
  const decision = evaluate(state, input, recorder);
  let withoutWinner: Pick<PolicyDecision, 'decision' | 'reason'> | null = null;
  const winner = recorder.winner;
  if (winner) {
    let candidate: PolicyState;
    if (winner.kind === 'session-deny') {
      candidate = {
        ...state,
        sessionDenials: state.sessionDenials.filter((d) => d.id !== winner.denialId),
      };
    } else {
      const key = pointKey(winner.point);
      const assignment = state.assignments.get(key);
      if (!assignment)
        return {
          decision,
          trace: { ...recorder, winner: null, withoutWinner },
        };
      const assignments = new Map(state.assignments);
      assignments.set(key, {
        ...assignment,
        exceptions: assignment.exceptions.filter((_, i) => i !== winner.index),
      });
      candidate = { ...state, assignments };
    }
    const result = evaluate(candidate, input);
    withoutWinner = { decision: result.decision, reason: result.reason };
  }
  return { decision, trace: { ...recorder, withoutWinner } };
}

function evaluate(
  state: PolicyState,
  input: PolicyInput,
  recorder?: TraceRecorder,
): PolicyDecision {
  const { principal, tool, masterOn, toYou, now } = input;
  const { point, assignment } = assignmentFor(state, principal);
  const profile = profileById(state, assignment.profileId) ?? OBSERVER;
  const targets = resolveTargets(input.targets, principal);
  const primary = targets[0];
  // A forced ask (spec 4.6, RS-D6) only turns an allow into an ask: a profile's deny stays a deny.
  // No grant passes it, because RS-D6 says it is always an ask.
  const baseRuleFor = (t: PolicyTarget): ToolRule =>
    forPrincipal(principal, effectiveRule(profile, assignment, tool, t));
  const forcedFor = (t: PolicyTarget): boolean =>
    input.forceAsk === true && baseRuleFor(t).decision !== 'deny';
  const ruleFor = (t: PolicyTarget): ToolRule =>
    forcedFor(t) ? { ...baseRuleFor(t), decision: 'ask' } : baseRuleFor(t);

  recorder?.stages.push('floors');
  if (!masterOn && tool !== 'list_agents')
    return done('deny', { by: 'floor', floor: 'master-off' }, ruleFor(primary));
  if (principal.kind === 'remote' && !remoteAllows(principal, tool))
    return done('deny', { by: 'floor', floor: 'remote-capability' }, ruleFor(primary));
  if (
    principal.kind === 'session' &&
    toYou &&
    (tool === 'send_message' || tool === 'request_input')
  )
    return done('allow', { by: 'floor', floor: 'local-to-you' }, ruleFor(primary));

  const overrides = [...(input.heldOverrides ?? []), ...state.overrides];
  const overrideFor = (t: PolicyTarget): OneUseOverride | undefined =>
    principal.kind === 'session'
      ? overrides.find(
          (o) =>
            o.sessionId === principal.sessionId &&
            o.tool === tool &&
            o.target.sessionId === t.sessionId &&
            samePath(o.target.path, t.path) &&
            (o.generation === undefined ||
              (o.generation === principal.generation &&
                samePath(o.target.folder, t.folder) &&
                o.target.projectId === t.projectId)),
        )
      : undefined;

  const denial =
    principal.kind === 'session'
      ? state.sessionDenials.find((d) => d.sessionId === principal.sessionId && d.tool === tool)
      : undefined;

  recorder?.stages.push('explicit-deny');
  const evaluated = targets.map((t) => {
    const matching: Array<{ exception: Exception; index: number }> = [];
    const base = forPrincipal(
      principal,
      effectiveRule(profile, assignment, tool, t, (exception, index) => {
        matching.push({ exception, index });
      }),
    );
    const forced = input.forceAsk === true && base.decision !== 'deny';
    const rule = forced ? { ...base, decision: 'ask' as const } : base;
    const fromException = matching.some(({ exception }) => exception.rule.decision !== undefined);
    const explicitDeny = (rule.decision === 'deny' && fromException) || denial !== undefined;
    return {
      target: t,
      rule,
      fromException,
      override: explicitDeny ? overrideFor(t) : undefined,
      explicitDeny,
      forced,
      matching,
    };
  });

  // see POL §4.3
  const explicit = evaluated.filter((e) => e.explicitDeny);
  const unpassed = explicit.find((e) => e.override === undefined);
  if (unpassed) {
    if (
      recorder &&
      input.targets.length === 1 &&
      targets.length === 1 &&
      (input.targets[0].sessionId !== null ||
        input.targets[0].path !== null ||
        input.targets[0].folder !== null)
    ) {
      const matching = unpassed.matching;
      const denials =
        principal.kind === 'session'
          ? state.sessionDenials.filter(
              (d) => d.sessionId === principal.sessionId && d.tool === tool,
            )
          : [];
      if (
        denials.length === 1 &&
        matching.length === 0 &&
        state.sessionDenials.filter((d) => d.id === denials[0].id).length === 1
      )
        recorder.winner = { kind: 'session-deny', denialId: denials[0].id };
      else if (
        denials.length === 0 &&
        matching.length === 1 &&
        matching[0].exception.rule.decision === 'deny' &&
        state.assignments.get(pointKey(point)) === assignment
      )
        recorder.winner = {
          kind: 'exception',
          point,
          index: matching[0].index,
          exception: matching[0].exception,
          scope: normalizedScope(matching[0].exception.scope),
          rule: unpassed.rule,
        };
    }
    return done(
      'deny',
      denial ? { by: 'session-deny', denialId: denial.id } : { by: 'deny', point },
      unpassed.rule,
      [],
      [],
      unpassed.target,
    );
  }
  const passing = explicit.filter((e) => e.override !== undefined);
  const overrideIds = [...new Set(passing.flatMap((e) => (e.override ? [e.override.id] : [])))];

  recorder?.stages.push('grants');
  const decided = evaluated.map((e) => {
    const grant =
      e.explicitDeny || e.forced
        ? undefined
        : state.grants.find(
            (g) =>
              isLiveGrant(g, now) &&
              g.tool === tool &&
              whoMatches(g.who, principal) &&
              matchesScope(g.on, e.target),
          );
    const effective: Decision = e.override || grant ? ALLOW : e.rule.decision;
    return { ...e, grant, effective };
  });

  const strictest = decided.reduce((best, e) =>
    STRICTNESS[e.effective] > STRICTNESS[best.effective] ? e : best,
  );
  const grantIds = [
    ...new Set(decided.flatMap((e) => (e.grant === undefined ? [] : [e.grant.id]))),
  ];
  if (strictest.effective === 'allow') {
    const first = passing[0];
    if (first?.override)
      return done(
        'allow',
        { by: 'override', overrideId: first.override.id },
        first.rule,
        grantIds,
        overrideIds,
      );
    const granted = decided.find((e) => e.grant !== undefined);
    if (granted?.grant)
      return done('allow', { by: 'grant', grantId: granted.grant.id }, granted.rule, grantIds);
  }
  recorder?.stages.push('assignment');
  const reason: Reason = strictest.fromException
    ? { by: 'exception', point, profileId: profile.id }
    : { by: 'profile', point, profileId: profile.id };
  return {
    ...done(
      strictest.effective,
      reason,
      strictest.rule,
      strictest.effective === 'allow' ? grantIds : [],
      strictest.effective === 'deny' ? [] : overrideIds,
    ),
    forcedAsk: strictest.forced && strictest.effective === 'ask',
  };
}

export function visibleTools(state: PolicyState, principal: Principal, now: number): ToolName[] {
  const { assignment } = assignmentFor(state, principal);
  const profile = profileById(state, assignment.profileId) ?? OBSERVER;
  return TOOL_NAMES.filter(
    (tool) => !isDeniedForEveryTarget(state, principal, profile, assignment, tool, now),
  );
}

function isDeniedForEveryTarget(
  state: PolicyState,
  principal: Principal,
  profile: Profile,
  assignment: Assignment,
  tool: ToolName,
  now: number,
): boolean {
  if (principal.kind === 'remote' && !remoteAllows(principal, tool)) return true;
  if (principal.kind === 'session' && (tool === 'send_message' || tool === 'request_input'))
    return false;
  if (
    principal.kind === 'session' &&
    state.sessionDenials.some((d) => d.sessionId === principal.sessionId && d.tool === tool)
  )
    return !state.overrides.some((o) => o.sessionId === principal.sessionId && o.tool === tool);
  // see POL §4.3 (T2.3 ruling)
  const narrowerAllows = assignment.exceptions.some(
    (e) =>
      e.tool === tool &&
      e.scope.kind !== 'anywhere' &&
      e.rule.decision !== undefined &&
      e.rule.decision !== 'deny',
  );
  if (
    !narrowerAllows &&
    assignment.exceptions.some(
      (e) => e.tool === tool && e.scope.kind === 'anywhere' && e.rule.decision === 'deny',
    )
  ) {
    return (
      principal.kind !== 'session' ||
      !state.overrides.some((o) => o.sessionId === principal.sessionId && o.tool === tool)
    );
  }
  if (profile.rules[tool].decision !== 'deny') return false;
  const settingExceptions = assignment.exceptions.filter(
    (e) => e.tool === tool && e.rule.decision !== undefined,
  );
  if (settingExceptions.some((e) => e.rule.decision !== 'deny')) return false;
  return !state.grants.some(
    (g) => isLiveGrant(g, now) && g.tool === tool && whoMatches(g.who, principal),
  );
}

function pointLabel(point: AssignmentPoint, cliName: (k: CliKind) => string): string {
  switch (point.kind) {
    case 'session':
      return 'session';
    case 'cli':
      return `default for ${cliName(point.cli)}`;
    case 'default':
      return 'default';
    case 'peer':
      return 'machine';
  }
}

export function reasonText(
  reason: Reason,
  decision: Decision,
  names: { profileName(id: ProfileId): string; cliName(k: CliKind): string },
): string {
  switch (reason.by) {
    case 'floor':
      return FLOOR_TEXT[reason.floor];
    case 'grant':
      return 'allowed by grant';
    case 'override':
      return 'allowed once';
    case 'session-deny':
      return 'denied for session';
    case 'deny':
      return `denied by exception (${pointLabel(reason.point, names.cliName)})`;
    case 'exception':
    case 'profile': {
      const name = names.profileName(reason.profileId);
      const suffix = reason.by === 'exception' ? ' +exception' : '';
      const label = pointLabel(reason.point, names.cliName);
      if (decision === 'ask') return `Ask: ${name}${suffix} (${label})`;
      return `${decision === 'allow' ? 'allowed' : 'denied'} by ${name}${suffix} (${label})`;
    }
  }
}
