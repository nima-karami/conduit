// see POL §4.2 and C6
import {
  DECISION_OF_ACCESS,
  effectiveRule,
  OBSERVER,
  pointKey,
  profileById,
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
  CLI_KINDS,
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
  profileById(state, a.profileId) ?? OBSERVER;

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
  ...(a.pinned === undefined ? {} : { pinned: a.pinned }),
});

export const pinKey = (tool: ToolName, field: PolicyField): string => `${tool}.${field}`;

// Keeps `pinned` absent when empty, so an unpinned assignment stays byte-identical to before.
export function withPinned(a: Assignment, keys: Iterable<string>): Assignment {
  const sorted = [...new Set(keys)].sort();
  const out: Assignment = { ...a };
  delete out.pinned;
  if (sorted.length > 0) out.pinned = sorted;
  return out;
}

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
  // A new point starts with no pins: the lower point's explicit choices are not this point's.
  const base =
    existing === undefined ? withPinned(copyAssignment(lowerA), []) : copyAssignment(existing);
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
  // Pins live on non-default points only; see plan "Third pass rulings".
  if (point.kind === 'default') return withPinned(next, []);
  // A concrete value is an explicit choice; 'inherit' hands the field back to the lower point.
  const pins = new Set(next.pinned ?? []);
  for (const field of ['access', 'when', 'reach', 'move'] as const) {
    const value = patch[field];
    if (value === undefined || !TOOL_SPECS[tool].fields.includes(field)) continue;
    if (value === 'inherit') pins.delete(pinKey(tool, field));
    else pins.add(pinKey(tool, field));
  }
  return withPinned(next, pins);
}

// see POL-D5
export function legacyLowerPoint(state: PolicyState, launchedCli: CliKind | null): AssignmentPoint {
  if (launchedCli !== null && state.assignments.has(pointKey({ kind: 'cli', cli: launchedCli })))
    return { kind: 'cli', cli: launchedCli };
  return { kind: 'default' };
}

export interface LegacyWrite {
  point: AssignmentPoint;
  assignment: Assignment;
}

/** undefined: no persisted record for the session's CLI; it lowers onto the default (see inheritorsOf). */
export type LaunchedCliOf = (sessionId: string) => CliKind | null | undefined;

const isCliKind = (v: string): v is CliKind => (CLI_KINDS as readonly string[]).includes(v);

function pointOfKey(key: string): AssignmentPoint | null {
  if (key === 'default') return { kind: 'default' };
  const sep = key.indexOf(':');
  if (sep < 0) return null;
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (kind === 'session') return { kind: 'session', sessionId: id };
  if (kind === 'cli' && isCliKind(id)) return { kind: 'cli', cli: id };
  return null;
}

// see C6: an inheritor is an assignment whose lower point is this one
function inheritorsOf(
  state: PolicyState,
  point: AssignmentPoint,
  launchedCliOf: LaunchedCliOf,
): Array<{ point: AssignmentPoint; assignment: Assignment }> {
  const out: Array<{ point: AssignmentPoint; assignment: Assignment }> = [];
  for (const [key, assignment] of state.assignments) {
    const p = pointOfKey(key);
    if (p === null) continue;
    let inherits = false;
    if (point.kind === 'default') {
      if (p.kind === 'cli') inherits = true;
      if (p.kind === 'session') {
        // An unresolved CLI lowers onto the default, as a session with no CLI does.
        const cli = launchedCliOf(p.sessionId) ?? null;
        inherits = legacyLowerPoint(state, cli).kind === 'default';
      }
    } else if (point.kind === 'cli' && p.kind === 'session') {
      inherits = launchedCliOf(p.sessionId) === point.cli;
    }
    if (inherits) out.push({ point: p, assignment });
  }
  return out;
}

// see C6 (M1): an edit reaches the inheritors that hold its old value, level by level
export function propagateLegacyPatch(
  state: PolicyState,
  point: AssignmentPoint,
  lower: AssignmentPoint | null,
  tool: ToolName,
  patch: ToolPolicyPatch,
  launchedCliOf: LaunchedCliOf,
): LegacyWrite[] | null {
  const edited = applyLegacyPatch(state, point, lower, tool, patch);
  if (edited === null) return null;
  const writes = new Map<string, LegacyWrite>([[pointKey(point), { point, assignment: edited }]]);
  const fields = (['access', 'when', 'reach', 'move'] as const).filter(
    (f) => TOOL_SPECS[tool].fields.includes(f) && patch[f] !== undefined,
  );
  // Each node is an assignment whose value changed: `before` is its pre-edit state, `after` its new one.
  let level: Array<{ point: AssignmentPoint; before: Assignment; after: Assignment }> = [
    {
      point,
      before: state.assignments.get(pointKey(point)) ?? assignmentOrWorker(state, lower),
      after: edited,
    },
  ];
  while (level.length > 0) {
    const next: typeof level = [];
    for (const node of level) {
      const beforeV = legacyPolicyOf(ruleAt(state, node.before, tool), tool);
      const afterV = legacyPolicyOf(ruleAt(state, node.after, tool), tool);
      const changed = fields.filter((f) => beforeV[f] !== afterV[f]);
      if (changed.length === 0) continue;
      for (const inheritor of inheritorsOf(state, node.point, launchedCliOf)) {
        const key = pointKey(inheritor.point);
        if (writes.has(key)) continue;
        // An explicit profile or on-screen choice is never an inheritance, even at the same value.
        if (
          inheritor.assignment.profileId !== node.before.profileId ||
          inheritor.assignment.onScreenOnly !== node.before.onScreenOnly
        ) {
          continue;
        }
        let current = inheritor.assignment;
        let touched = false;
        for (const field of changed) {
          if (legacyPolicyOf(ruleAt(state, current, tool), tool)[field] !== beforeV[field])
            continue;
          // A pinned field is an explicit choice on the inheritor; a default edit does not reach it.
          if (current.pinned?.includes(pinKey(tool, field))) continue;
          const wanted = afterV[field];
          if (wanted === undefined) continue;
          if (current.exceptions.some((e) => e.scope.kind !== 'anywhere')) return null;
          current = applyField(state, current, current, tool, field, wanted);
          touched = true;
        }
        if (!touched) continue;
        writes.set(key, { point: inheritor.point, assignment: current });
        next.push({ point: inheritor.point, before: inheritor.assignment, after: current });
      }
    }
    level = next;
  }
  return [...writes.values()];
}
