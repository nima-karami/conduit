import type { NativeFamily, NativeModes, NativeSelection } from '../contracts/native-launch';
import type { RemotePolicyDoc } from '../contracts/remote-policy';
import { assignmentFor } from './policy-engine';
import { pointKey, profileById } from './policy-profiles';
import type { Assignment, AssignmentPoint, PolicyState, Profile, ProfileId } from './policy-types';

type AssignmentEntry = { point: AssignmentPoint; assignment: Assignment };
type PolicyProjectionInput = {
  profiles: readonly Profile[];
  assignments: readonly AssignmentEntry[];
};

const FAMILIES = ['claude', 'codex'] as const;
const UNSET: NativeModes = { claude: 'unset', codex: 'unset' };

export const isNativeFamily = (kind: string | null): kind is NativeFamily =>
  kind === 'claude' || kind === 'codex';

export const supportsNativePoint = (point: AssignmentPoint): boolean =>
  point.kind === 'default' ||
  point.kind === 'session' ||
  (point.kind === 'cli' && isNativeFamily(point.cli));

export function assignmentMap(entries: readonly AssignmentEntry[]): Map<string, Assignment> {
  return new Map(entries.map(({ point, assignment }) => [pointKey(point), assignment]));
}

type Outcome = readonly [ProfileId, NativeModes[NativeFamily] | 'missing'] | null;

function outcome(state: PolicyState, sessionId: string, family: NativeFamily): Outcome {
  const { assignment } = assignmentFor(state, {
    kind: 'session',
    sessionId,
    handle: '',
    launchedCli: family,
    homeFolder: null,
    projectId: null,
  });
  if (assignment.applyNative !== true) return null;
  const profile = profileById(state, assignment.profileId);
  return [assignment.profileId, profile ? (profile.nativeModes ?? UNSET)[family] : 'missing'];
}

export function selectNative(
  state: PolicyState,
  id: string,
  family: NativeFamily,
): NativeSelection {
  const selected = outcome(state, id, family);
  const mode = selected?.[1];
  if (mode === 'missing') return { status: 'unavailable' };
  if (family === 'claude' && (mode === 'plan' || mode === 'acceptEdits'))
    return { status: 'available', intent: { family, optedIn: true, requested: { mode } } };
  if (family === 'codex' && (mode === 'read-only' || mode === 'workspace-write'))
    return {
      status: 'available',
      intent: { family, optedIn: true, requested: { sandbox: mode, approval: 'on-request' } },
    };
  return { status: 'available', intent: { family, optedIn: selected !== null, requested: null } };
}

const compareKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function nativeProjection(input: PolicyProjectionInput): string {
  const state: PolicyState = {
    profiles: input.profiles,
    assignments: assignmentMap(input.assignments),
    grants: [],
    overrides: [],
    sessionDenials: [],
    failClosed: false,
  };
  const custom = input.profiles
    .flatMap(({ id, nativeModes: modes }) =>
      id.startsWith('p-') && modes && (modes.claude !== 'unset' || modes.codex !== 'unset')
        ? [[id, modes.claude, modes.codex]]
        : [],
    )
    .sort(([a], [b]) => compareKey(a, b));
  const optedIn = input.assignments
    .flatMap(({ point, assignment }) =>
      supportsNativePoint(point) && assignment.applyNative === true
        ? [[pointKey(point), assignment.profileId]]
        : [],
    )
    .sort(([a], [b]) => compareKey(a, b));
  const sessions = [
    ...new Set(
      input.assignments.flatMap(({ point }) => (point.kind === 'session' ? [point.sessionId] : [])),
    ),
  ].sort();
  let probe = '';
  while (state.assignments.has(pointKey({ kind: 'session', sessionId: probe }))) probe += '_';
  const generic = FAMILIES.map((family) => outcome(state, probe, family));
  const overrides = sessions.flatMap((sessionId) =>
    FAMILIES.flatMap((family, i) => {
      const current = outcome(state, sessionId, family);
      return current?.[0] === generic[i]?.[0] && current?.[1] === generic[i]?.[1]
        ? []
        : [[sessionId, family, current]];
    }),
  );
  return JSON.stringify([custom, optedIn, generic, overrides]);
}

export function stripNativeFields(doc: RemotePolicyDoc): RemotePolicyDoc {
  return {
    profiles: doc.profiles.map((profile) => {
      const copy = { ...profile };
      delete copy.nativeModes;
      return copy;
    }),
    assignments: doc.assignments.map(({ point, assignment }) => {
      const copy = { ...assignment };
      delete copy.applyNative;
      return { point, assignment: copy };
    }),
  };
}
