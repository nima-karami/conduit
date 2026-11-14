// see POL §4.2 and C6
import { effectiveRule, pointKey, profileById, WORKER_PROFILE } from './policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Exception,
  PolicyState,
  ToolRule,
} from './policy-types';
import {
  type Access,
  type PolicyLayer,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
  type ToolPolicy,
  type ToolPolicyPatch,
} from './tool-policy';

const ACCESS_OF_DECISION: Record<Decision, Access> = { allow: 'on', ask: 'ask', deny: 'off' };
const DECISION_OF_ACCESS: Record<Access, Decision> = { on: 'allow', ask: 'ask', off: 'deny' };

export const decisionOfAccess = (access: Access): Decision => DECISION_OF_ACCESS[access];

export function legacyPolicyOf(rule: ToolRule, tool: ToolName): ToolPolicy {
  const fields = TOOL_SPECS[tool].fields;
  const out: ToolPolicy = { access: ACCESS_OF_DECISION[rule.decision] };
  if (fields.includes('when') && rule.when !== null) out.when = rule.when;
  if (fields.includes('reach') && rule.reach !== null) out.reach = rule.reach;
  if (fields.includes('move') && rule.move !== null) out.move = rule.move;
  return out;
}

const plainWorker = (): Assignment => ({
  profileId: 'worker',
  exceptions: [],
  onScreenOnly: false,
});

const assignmentOrWorker = (state: PolicyState, point: AssignmentPoint | null): Assignment =>
  (point === null ? undefined : state.assignments.get(pointKey(point))) ?? plainWorker();

const effectiveAt = (state: PolicyState, a: Assignment, tool: ToolName): ToolRule =>
  effectiveRule(profileById(state, a.profileId) ?? WORKER_PROFILE, a, tool, null);

const isAnywhereFor = (tool: ToolName) => (e: Exception) =>
  e.tool === tool && e.scope.kind === 'anywhere';

const copyException = (e: Exception): Exception => ({
  tool: e.tool,
  scope: { ...e.scope },
  rule: { ...e.rule },
});

const seedFrom = (lower: Assignment): Assignment => ({
  profileId: lower.profileId,
  onScreenOnly: lower.onScreenOnly,
  exceptions: lower.exceptions.filter((e) => e.scope.kind === 'anywhere').map(copyException),
});

export function projectLegacyLayer(
  state: PolicyState,
  point: AssignmentPoint,
  lower: AssignmentPoint | null,
): PolicyLayer {
  const at = state.assignments.get(pointKey(point));
  if (at === undefined) return {};
  const below = assignmentOrWorker(state, lower);
  const layer: PolicyLayer = {};
  for (const tool of TOOL_NAMES) {
    const here = legacyPolicyOf(effectiveAt(state, at, tool), tool);
    const beneath = legacyPolicyOf(effectiveAt(state, below, tool), tool);
    const entry: Partial<ToolPolicy> = {};
    if (here.access !== beneath.access) entry.access = here.access;
    if (here.when !== beneath.when) entry.when = here.when;
    if (here.reach !== beneath.reach) entry.reach = here.reach;
    if (here.move !== beneath.move) entry.move = here.move;
    if (Object.keys(entry).length) layer[tool] = entry;
  }
  return layer;
}

export function applyLegacyPatch(
  state: PolicyState,
  point: AssignmentPoint,
  lower: AssignmentPoint | null,
  tool: ToolName,
  patch: ToolPolicyPatch,
): Assignment {
  const existing = state.assignments.get(pointKey(point));
  const base: Assignment =
    existing !== undefined
      ? { ...existing, exceptions: existing.exceptions.map(copyException) }
      : seedFrom(assignmentOrWorker(state, lower));

  const current = base.exceptions.find(isAnywhereFor(tool));
  const rule: Partial<ToolRule> = { ...current?.rule };
  if (patch.access === 'inherit') delete rule.decision;
  else if (patch.access !== undefined) rule.decision = DECISION_OF_ACCESS[patch.access];
  if (patch.when === 'inherit') delete rule.when;
  else if (patch.when !== undefined) rule.when = patch.when;
  if (patch.reach === 'inherit') delete rule.reach;
  else if (patch.reach !== undefined) rule.reach = patch.reach;
  if (patch.move === 'inherit') delete rule.move;
  else if (patch.move !== undefined) rule.move = patch.move;

  const keep = Object.keys(rule).length > 0;
  const updated: Exception = { tool, scope: { kind: 'anywhere' }, rule };
  let exceptions: Exception[];
  if (current !== undefined) {
    exceptions = keep
      ? base.exceptions.map((e) => (e === current ? updated : e))
      : base.exceptions.filter((e) => e !== current);
  } else {
    exceptions = keep ? [...base.exceptions, updated] : base.exceptions;
  }
  return { ...base, exceptions };
}
