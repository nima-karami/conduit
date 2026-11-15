// see POL §4.2 "Migration (exact)" and C6
import type { PolicyFile } from './policy-file';
import {
  BUILT_IN_PROFILES,
  DECISION_OF_ACCESS,
  effectiveRule,
  WORKER_PROFILE,
} from './policy-profiles';
import { legacyPolicyOf } from './policy-projection';
import type { Assignment, Exception, Profile, ToolRule } from './policy-types';
import {
  CLI_KINDS,
  type CliKind,
  type CliPolicyLayers,
  type GlobalPolicy,
  type PolicyLayer,
  resolvePolicy,
  TOOL_NAMES,
  type ToolName,
  type ToolPolicy,
} from './tool-policy';

export interface LegacyPolicy {
  global: GlobalPolicy;
  byCli: CliPolicyLayers;
  sessions: Array<{ sessionId: string; layer: PolicyLayer; cli: CliKind | null }>;
}

type TodayOf = (tool: ToolName) => ToolPolicy;

function builtInLead(): Profile {
  const lead = BUILT_IN_PROFILES.find((p) => p.id === 'lead');
  if (lead === undefined) throw new Error('Lead is a built-in profile');
  return lead;
}
const LEAD_PROFILE = builtInLead();

const sameLegacy = (x: ToolPolicy, y: ToolPolicy): boolean =>
  x.access === y.access && x.when === y.when && x.reach === y.reach && x.move === y.move;

const hasFields = (layer: PolicyLayer): boolean =>
  Object.values(layer).some((entry) => entry !== undefined && Object.keys(entry).length > 0);

const isPlainWorker = (a: Assignment): boolean =>
  a.profileId === 'worker' && a.exceptions.length === 0 && !a.onScreenOnly;

function assignmentFor(today: TodayOf): Assignment {
  const lead: Assignment = { profileId: 'lead', exceptions: [], onScreenOnly: true };
  const leadMatches = TOOL_NAMES.every((tool) =>
    sameLegacy(legacyPolicyOf(effectiveRule(LEAD_PROFILE, lead, tool, null), tool), today(tool)),
  );
  if (leadMatches) return lead;

  const exceptions: Exception[] = [];
  for (const tool of TOOL_NAMES) {
    const worker = legacyPolicyOf(WORKER_PROFILE.rules[tool], tool);
    const want = today(tool);
    const rule: Partial<ToolRule> = {};
    if (want.access !== worker.access) rule.decision = DECISION_OF_ACCESS[want.access];
    if (want.when !== worker.when && want.when !== undefined) rule.when = want.when;
    if (want.reach !== worker.reach && want.reach !== undefined) rule.reach = want.reach;
    if (want.move !== worker.move && want.move !== undefined) rule.move = want.move;
    if (Object.keys(rule).length > 0) exceptions.push({ tool, scope: { kind: 'anywhere' }, rule });
  }
  return { profileId: 'worker', exceptions, onScreenOnly: false };
}

export function migrateLegacyPolicy(
  legacy: LegacyPolicy,
): Pick<PolicyFile, 'assignments' | 'migratedFrom' | 'notes'> {
  const { global, byCli, sessions } = legacy;
  const assignments: PolicyFile['assignments'] = [];
  const onScreenOnlyOffered: string[] = [];

  const defaultAssignment = assignmentFor((tool) => resolvePolicy(tool, { global }).policy);
  if (!isPlainWorker(defaultAssignment))
    assignments.push({ point: { kind: 'default' }, assignment: defaultAssignment });

  for (const cli of CLI_KINDS) {
    const layer = byCli[cli];
    if (layer === undefined || !hasFields(layer)) continue;
    assignments.push({
      point: { kind: 'cli', cli },
      assignment: assignmentFor((tool) => resolvePolicy(tool, { cli: layer, global }).policy),
    });
  }

  for (const s of sessions) {
    if (!hasFields(s.layer)) continue;
    const cliLayer = s.cli === null ? undefined : byCli[s.cli];
    const assignment = assignmentFor(
      (tool) => resolvePolicy(tool, { session: s.layer, cli: cliLayer, global }).policy,
    );
    assignments.push({ point: { kind: 'session', sessionId: s.sessionId }, assignment });
    if (assignment.profileId === 'lead') onScreenOnlyOffered.push(s.sessionId);
  }

  return { assignments, migratedFrom: 'v0.64', notes: { onScreenOnlyOffered } };
}
