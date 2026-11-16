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
  ToolRule,
} from './policy-types';
import { type CliKind, TOOL_NAMES, type ToolName } from './tool-policy';

// see NET §4.1 (R21)
// The machine tools are not in NET's table: a read of this side's links is monitor, and adding or
// dropping a link is orchestrate (off for every remote in v1), so a peer cannot reshape our fleet.
const CAPABILITY_OF: Record<ToolName, Capability | 'orchestrate'> = {
  list_machines: 'monitor',
  connect_machine: 'orchestrate',
  disconnect_machine: 'orchestrate',
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
const DEFAULT_ASSIGNMENT: Assignment = { profileId: 'worker', exceptions: [], onScreenOnly: false };
const ALLOW: Decision = 'allow';
const FLOOR_TEXT: Record<FloorId, string> = {
  'master-off': 'Conduit tools are off',
  'remote-capability': 'not allowed on this link',
  'local-to-you': 'always allowed to you',
};

const EMPTY_TARGET: PolicyTarget = { sessionId: null, path: null, folder: null, projectId: null };

function resolveTargets(targets: readonly PolicyTarget[], principal: Principal): PolicyTarget[] {
  const list = targets.length === 0 ? [EMPTY_TARGET] : targets;
  return list.map((t) => resolveTarget(t, principal));
}

export const samePath = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : folderKey(a) === folderKey(b);

function remoteAllows(principal: Extract<Principal, { kind: 'remote' }>, tool: ToolName): boolean {
  const cap = CAPABILITY_OF[tool];
  return cap !== 'orchestrate' && principal.capabilities[cap];
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
): { point: AssignmentPoint; assignment: Assignment } {
  if (state.failClosed) return { point: { kind: 'default' }, assignment: OBSERVER_ASSIGNMENT };
  if (p.kind === 'remote') {
    const point: AssignmentPoint = { kind: 'peer', machineId: p.machineId };
    return { point, assignment: state.assignments.get(pointKey(point)) ?? OWN_PEER_ASSIGNMENT };
  }
  const candidates: AssignmentPoint[] = [{ kind: 'session', sessionId: p.sessionId }];
  if (p.launchedCli !== null) candidates.push({ kind: 'cli', cli: p.launchedCli });
  candidates.push({ kind: 'default' });
  for (const point of candidates) {
    const assignment = state.assignments.get(pointKey(point));
    if (assignment) return { point, assignment };
  }
  return { point: { kind: 'default' }, assignment: DEFAULT_ASSIGNMENT };
}

export function decide(state: PolicyState, input: PolicyInput): PolicyDecision {
  const { principal, tool, masterOn, toYou, now } = input;
  const { point, assignment } = assignmentFor(state, principal);
  const profile = profileById(state, assignment.profileId) ?? OBSERVER;
  const targets = resolveTargets(input.targets, principal);
  const primary = targets[0];
  // A forced ask (spec 4.6, RS-D6) only turns an allow into an ask: a profile's deny is still a deny,
  // and a grant can still pass the ask, as it passes any ask.
  const ruleFor = (t: PolicyTarget): ToolRule => {
    const rule = forPrincipal(principal, effectiveRule(profile, assignment, tool, t));
    return input.forceAsk && rule.decision === 'allow' ? { ...rule, decision: 'ask' } : rule;
  };

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
            samePath(o.target.path, t.path),
        )
      : undefined;

  const evaluated = targets.map((t) => {
    const rule = ruleFor(t);
    const fromException = assignment.exceptions.some(
      (e) => e.tool === tool && e.rule.decision !== undefined && matchesScope(e.scope, t),
    );
    const explicitDeny = rule.decision === 'deny' && fromException;
    return {
      target: t,
      rule,
      fromException,
      override: explicitDeny ? overrideFor(t) : undefined,
      explicitDeny,
    };
  });

  // see POL §4.3
  const explicit = evaluated.filter((e) => e.explicitDeny);
  const unpassed = explicit.find((e) => e.override === undefined);
  if (unpassed) return done('deny', { by: 'deny', point }, unpassed.rule, [], [], unpassed.target);
  const passing = explicit.filter((e) => e.override !== undefined);
  const overrideIds = [...new Set(passing.flatMap((e) => (e.override ? [e.override.id] : [])))];

  const decided = evaluated.map((e) => {
    const grant = e.explicitDeny
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
  const reason: Reason = strictest.fromException
    ? { by: 'exception', point, profileId: profile.id }
    : { by: 'profile', point, profileId: profile.id };
  return done(
    strictest.effective,
    reason,
    strictest.rule,
    strictest.effective === 'allow' ? grantIds : [],
    strictest.effective === 'deny' ? [] : overrideIds,
  );
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
