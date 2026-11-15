// see POL §4.2 and C6
import {
  DECISION_OF_ACCESS,
  effectiveRule,
  pointKey,
  profileById,
  WORKER_PROFILE,
} from './policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Exception,
  PolicyState,
  Profile,
  ToolRule,
} from './policy-types';
import {
  ACCESS_VALUES,
  type Access,
  type CliKind,
  type Move,
  type PolicyField,
  type PolicyLayer,
  type Reach,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
  type ToolPolicy,
  type ToolPolicyPatch,
  type When,
} from './tool-policy';

const accessOfDecision = (decision: Decision): Access => {
  const access = ACCESS_VALUES.find((a) => DECISION_OF_ACCESS[a] === decision);
  if (access === undefined) throw new Error(`no legacy access for decision ${decision}`);
  return access;
};

export function legacyPolicyOf(rule: ToolRule, tool: ToolName): ToolPolicy {
  const fields = TOOL_SPECS[tool].fields;
  const out: ToolPolicy = { access: accessOfDecision(rule.decision) };
  if (fields.includes('when') && rule.when !== null) out.when = rule.when;
  if (fields.includes('reach') && rule.reach !== null) out.reach = rule.reach;
  if (fields.includes('move') && rule.move !== null) out.move = rule.move;
  return out;
}

const RULE_KEY = {
  access: 'decision',
  when: 'when',
  reach: 'reach',
  move: 'move',
} as const satisfies Record<PolicyField, keyof ToolRule>;

const plainWorker = (): Assignment => ({
  profileId: 'worker',
  exceptions: [],
  onScreenOnly: false,
});

const profileOf = (state: PolicyState, a: Assignment): Profile =>
  profileById(state, a.profileId) ?? WORKER_PROFILE;

const ruleAt = (state: PolicyState, a: Assignment, tool: ToolName): ToolRule =>
  effectiveRule(profileOf(state, a), a, tool, null);

const assignmentOrWorker = (state: PolicyState, point: AssignmentPoint | null): Assignment =>
  (point === null ? undefined : state.assignments.get(pointKey(point))) ?? plainWorker();

const copyException = (e: Exception): Exception => ({
  tool: e.tool,
  scope: { ...e.scope },
  rule: { ...e.rule },
});

const copyAssignment = (a: Assignment): Assignment => ({
  profileId: a.profileId,
  onScreenOnly: a.onScreenOnly,
  exceptions: a.exceptions.map(copyException),
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
    const here = legacyPolicyOf(ruleAt(state, at, tool), tool);
    const beneath = legacyPolicyOf(ruleAt(state, below, tool), tool);
    const entry: Partial<ToolPolicy> = {};
    if (here.access !== beneath.access) entry.access = here.access;
    if (here.when !== beneath.when) entry.when = here.when;
    if (here.reach !== beneath.reach) entry.reach = here.reach;
    if (here.move !== beneath.move) entry.move = here.move;
    if (Object.keys(entry).length) layer[tool] = entry;
  }
  return layer;
}

function editAnywhere(
  a: Assignment,
  tool: ToolName,
  edit: (rule: Partial<ToolRule>) => void,
): Assignment {
  const current = a.exceptions.find((e) => e.tool === tool && e.scope.kind === 'anywhere');
  const rule: Partial<ToolRule> = { ...current?.rule };
  edit(rule);
  if (Object.keys(rule).length === 0) {
    return { ...a, exceptions: a.exceptions.filter((e) => e !== current) };
  }
  const updated: Exception = { tool, scope: { kind: 'anywhere' }, rule };
  const exceptions =
    current === undefined
      ? [...a.exceptions, updated]
      : a.exceptions.map((e) => (e === current ? updated : e));
  return { ...a, exceptions };
}

const isAccess = (v: Access | When | Reach | Move): v is Access =>
  ACCESS_VALUES.some((a) => a === v);

const toRuleValue = (v: Access | When | Reach | Move): Decision | When | Reach | Move =>
  isAccess(v) ? DECISION_OF_ACCESS[v] : v;

function applyField(
  state: PolicyState,
  lowerA: Assignment,
  a: Assignment,
  tool: ToolName,
  field: PolicyField,
  value: Access | When | Reach | Move | 'inherit',
): Assignment {
  if (!TOOL_SPECS[tool].fields.includes(field)) return a;
  let next = a;
  if (field === 'when' && a.onScreenOnly) {
    // Clearing onScreenOnly must not move any other tool off 'viewing'.
    next = { ...a, onScreenOnly: false };
    for (const other of TOOL_NAMES) {
      if (other === tool) continue;
      const before = ruleAt(state, a, other).when;
      if (before !== ruleAt(state, next, other).when) {
        next = editAnywhere(next, other, (rule) => {
          rule.when = before;
        });
      }
    }
  }
  const wanted =
    value === 'inherit' ? legacyPolicyOf(ruleAt(state, lowerA, tool), tool)[field] : value;
  if (wanted === undefined) return next;
  const profileValue = legacyPolicyOf(profileOf(state, next).rules[tool], tool)[field];
  return editAnywhere(next, tool, (rule) => {
    if (wanted === profileValue) delete rule[RULE_KEY[field]];
    else Object.assign(rule, { [RULE_KEY[field]]: toRuleValue(wanted) });
  });
}

// The old editors cannot express a scope, so a point or lower holding one is refused, not guessed at.
export function applyLegacyPatch(
  state: PolicyState,
  point: AssignmentPoint,
  lower: AssignmentPoint | null,
  tool: ToolName,
  patch: ToolPolicyPatch,
): Assignment | null {
  const lowerA = assignmentOrWorker(state, lower);
  const existing = state.assignments.get(pointKey(point));
  const base = copyAssignment(existing ?? lowerA);
  const applies = (field: PolicyField): boolean =>
    patch[field] !== undefined && TOOL_SPECS[tool].fields.includes(field);
  if (!(['access', 'when', 'reach', 'move'] as const).some(applies)) return base;
  const scoped = (a: Assignment | undefined): boolean =>
    a?.exceptions.some((e) => e.scope.kind !== 'anywhere') ?? false;
  if (scoped(existing) || scoped(lowerA)) return null;
  let next = base;
  if (patch.access !== undefined)
    next = applyField(state, lowerA, next, tool, 'access', patch.access);
  if (patch.when !== undefined) next = applyField(state, lowerA, next, tool, 'when', patch.when);
  if (patch.reach !== undefined) next = applyField(state, lowerA, next, tool, 'reach', patch.reach);
  if (patch.move !== undefined) next = applyField(state, lowerA, next, tool, 'move', patch.move);
  return next;
}

// see POL-D5: a session's legacy edits lower onto its launched CLI's point, never its handle's CLI.
export function legacyLowerPoint(state: PolicyState, launchedCli: CliKind | null): AssignmentPoint {
  if (launchedCli !== null && state.assignments.has(pointKey({ kind: 'cli', cli: launchedCli })))
    return { kind: 'cli', cli: launchedCli };
  return { kind: 'default' };
}
