// Precedence is POL §4.3: floors, explicit denies, grants, then the most specific assignment.
import type { Capability } from '../contracts/remote-principal';
import { folderKey } from '../folder-key';
import {
  effectiveRule,
  matchesScope,
  pointKey,
  profileById,
  STRICTNESS,
  WORKER_PROFILE,
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
const CAPABILITY_OF: Record<ToolName, Capability | 'orchestrate'> = {
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

function noTarget(principal: Principal): PolicyTarget {
  if (principal.kind === 'session')
    return {
      sessionId: null,
      path: principal.homeFolder,
      folder: principal.homeFolder,
      projectId: principal.projectId,
    };
  return { sessionId: null, path: null, folder: null, projectId: null };
}

// An action with no target matches the caller's home folder (spec §4.1).
function resolveTargets(targets: readonly PolicyTarget[], principal: Principal): PolicyTarget[] {
  if (targets.length === 0) return [noTarget(principal)];
  return targets.map((t) =>
    t.sessionId === null && t.path === null && t.folder === null ? noTarget(principal) : t,
  );
}

const samePath = (a: string | null, b: string | null): boolean =>
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

function isLiveGrant(g: Grant, now: number): boolean {
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
  grantId: string | null = null,
  overrideId: string | null = null,
): PolicyDecision {
  return {
    decision,
    reason,
    rule: { when: rule.when, reach: rule.reach, move: rule.move },
    grantId,
    overrideId,
  };
}

export function assignmentFor(
  state: PolicyState,
  p: Principal,
): { point: AssignmentPoint; assignment: Assignment } {
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
  const profile = profileById(state, assignment.profileId) ?? WORKER_PROFILE;
  const targets = resolveTargets(input.targets, principal);
  const primary = targets[0];
  const ruleFor = (t: PolicyTarget): ToolRule =>
    forPrincipal(principal, effectiveRule(profile, assignment, tool, t));

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

  const overrideFor = (t: PolicyTarget): OneUseOverride | undefined =>
    principal.kind === 'session'
      ? state.overrides.find(
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
      rule,
      fromException,
      override: explicitDeny ? overrideFor(t) : undefined,
      explicitDeny,
    };
  });

  const blocked = evaluated.find((e) => e.explicitDeny && e.override === undefined);
  if (blocked) return done('deny', { by: 'deny', point }, blocked.rule);

  const grant = state.grants.find(
    (g) =>
      isLiveGrant(g, now) &&
      g.tool === tool &&
      whoMatches(g.who, principal) &&
      targets.every((t) => matchesScope(g.on, t)),
  );
  if (grant) return done('allow', { by: 'grant', grantId: grant.id }, ruleFor(primary), grant.id);

  const strictest = evaluated
    .map((e) => ({ ...e, effective: e.override ? ALLOW : e.rule.decision }))
    .reduce((best, e) => (STRICTNESS[e.effective] > STRICTNESS[best.effective] ? e : best));
  if (strictest.override)
    return done(
      'allow',
      { by: 'override', overrideId: strictest.override.id },
      strictest.rule,
      null,
      strictest.override.id,
    );
  const reason: Reason = strictest.fromException
    ? { by: 'exception', point, profileId: profile.id }
    : { by: 'profile', point, profileId: profile.id };
  return done(strictest.effective, reason, strictest.rule);
}

export function visibleTools(state: PolicyState, principal: Principal, now: number): ToolName[] {
  const { assignment } = assignmentFor(state, principal);
  const profile = profileById(state, assignment.profileId) ?? WORKER_PROFILE;
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
