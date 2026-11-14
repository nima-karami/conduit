// Built-ins are derived from TOOL_SPECS so Worker cannot drift from the access defaults.
// see POL §4.2

import type {
  Assignment,
  AssignmentPoint,
  Decision,
  Exception,
  PolicyState,
  PolicyTarget,
  Profile,
  ProfileId,
  Scope,
  ToolRule,
} from './policy-types';
import {
  type Access,
  type PolicyField,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
} from './tool-policy';

const DECISION_OF_ACCESS: Record<Access, Decision> = { off: 'deny', ask: 'ask', on: 'allow' };
const LEAD_ALLOWED: readonly ToolName[] = [
  'open_session',
  'open_terminal',
  'send_input',
  'close_session',
  'attach_folder',
];
const OBSERVER_ALLOWED: readonly ToolName[] = [
  'list_sessions',
  'read_inbox',
  'read_attachment',
  'send_message',
  'wait_sessions',
  'list_agents',
  'request_input',
  'wait_request',
  'withdraw_request',
  'list_requests',
];

function workerRule(tool: ToolName): ToolRule {
  const spec = TOOL_SPECS[tool];
  const applies = (field: PolicyField): boolean => spec.fields.includes(field);
  return {
    decision: DECISION_OF_ACCESS[spec.defaults.access],
    when: applies('when') ? (spec.defaults.when ?? null) : null,
    reach: applies('reach') ? (spec.defaults.reach ?? null) : null,
    move: applies('move') ? (spec.defaults.move ?? null) : null,
  };
}

function ruleSet(rule: (tool: ToolName, worker: ToolRule) => ToolRule): Record<ToolName, ToolRule> {
  const out = {} as Record<ToolName, ToolRule>;
  for (const tool of TOOL_NAMES) out[tool] = rule(tool, workerRule(tool));
  return out;
}

export const WORKER_PROFILE: Profile = {
  id: 'worker',
  name: 'Worker',
  builtIn: true,
  rules: ruleSet((_tool, worker) => worker),
};

const OBSERVER: Profile = {
  id: 'observer',
  name: 'Observer',
  builtIn: true,
  rules: ruleSet((tool, worker) => ({
    ...worker,
    decision: OBSERVER_ALLOWED.includes(tool) ? worker.decision : 'deny',
  })),
};

const LEAD: Profile = {
  id: 'lead',
  name: 'Lead',
  builtIn: true,
  rules: ruleSet((tool, worker) => ({
    ...worker,
    decision: LEAD_ALLOWED.includes(tool) ? 'allow' : worker.decision,
    when: worker.when === null ? null : 'always',
  })),
};

export const BUILT_IN_PROFILES: readonly Profile[] = [OBSERVER, WORKER_PROFILE, LEAD];

export function profileById(state: PolicyState, id: ProfileId): Profile | null {
  return (
    BUILT_IN_PROFILES.find((p) => p.id === id) ?? state.profiles.find((p) => p.id === id) ?? null
  );
}

export function pointKey(p: AssignmentPoint): string {
  switch (p.kind) {
    case 'session':
      return `session:${p.sessionId}`;
    case 'peer':
      return `peer:${p.machineId}`;
    case 'cli':
      return `cli:${p.cli}`;
    case 'default':
      return 'default';
  }
}

// Folder comparisons are string-level on both separators so the result never depends on the
// host platform; CI runs on ubuntu and the same answer must come out on win32.
const normPath = (p: string): string => {
  const slashed = p.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
};

const isUnder = (path: string, base: string): boolean =>
  path === base || path.startsWith(base === '/' ? '/' : `${base}/`);

export function matchesScope(scope: Scope, target: PolicyTarget | null): boolean {
  if (scope.kind === 'anywhere') return true;
  if (target === null) return false;
  switch (scope.kind) {
    case 'space':
      return target.projectId === scope.projectId;
    case 'folder':
      return target.path !== null && isUnder(normPath(target.path), normPath(scope.path));
    case 'path':
      return target.path !== null && normPath(target.path) === normPath(scope.path);
    case 'session':
      return target.sessionId !== null && target.sessionId === scope.sessionId;
  }
}

// Wider first, so a narrower exception sets its fields last and wins.
function specificity(scope: Scope): readonly [number, number] {
  switch (scope.kind) {
    case 'anywhere':
      return [0, 0];
    case 'space':
      return [1, 0];
    case 'folder':
      return [2, normPath(scope.path).length];
    case 'path':
    case 'session':
      return [3, 0];
  }
}

const STRICTNESS: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
const decisionStrictness = (e: Exception): number =>
  e.rule.decision === undefined ? -1 : STRICTNESS[e.rule.decision];

function applyOrder(x: Exception, y: Exception): number {
  const [xr, xl] = specificity(x.scope);
  const [yr, yl] = specificity(y.scope);
  if (xr !== yr) return xr - yr;
  if (xl !== yl) return xl - yl;
  return decisionStrictness(x) - decisionStrictness(y);
}

export function effectiveRule(
  profile: Profile,
  a: Assignment,
  tool: ToolName,
  target: PolicyTarget | null,
): ToolRule {
  const rule: ToolRule = { ...profile.rules[tool] };
  const applicable = a.exceptions
    .filter((e) => e.tool === tool && matchesScope(e.scope, target))
    .sort(applyOrder);
  for (const e of applicable) {
    if (e.rule.decision !== undefined) rule.decision = e.rule.decision;
    if (e.rule.when !== undefined) rule.when = e.rule.when;
    if (e.rule.reach !== undefined) rule.reach = e.rule.reach;
    if (e.rule.move !== undefined) rule.move = e.rule.move;
  }
  if (a.onScreenOnly && rule.when !== null) rule.when = 'viewing';
  return rule;
}
