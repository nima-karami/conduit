// Node-free: the renderer imports these. See spec 2026-11-14-policy-and-permissions §4.

import type { NativeModes } from '../contracts/native-launch';
import type { Capabilities, RemotePrincipal } from '../contracts/remote-principal';
import type { GrantChoice } from './grant-store';
import type {
  CliKind,
  CliPolicyLayers,
  Move,
  PolicyLayer,
  Reach,
  ToolName,
  When,
} from './tool-policy';

export type Decision = 'allow' | 'ask' | 'deny';
export type BuiltInProfileId = 'observer' | 'worker' | 'lead';
export type ProfileId = BuiltInProfileId | `p-${string}`;

/** null = the tool has no such field in TOOL_SPECS. */
export interface ToolRule {
  decision: Decision;
  when: When | null;
  reach: Reach | null;
  move: Move | null;
}

export interface Profile {
  id: ProfileId;
  name: string;
  builtIn: boolean;
  nativeModes?: NativeModes;
  rules: Record<ToolName, ToolRule>;
}

export type Scope =
  | { kind: 'anywhere' }
  | { kind: 'space'; projectId: string }
  | { kind: 'folder'; path: string }
  | { kind: 'path'; path: string }
  | { kind: 'session'; sessionId: string };

export interface Exception {
  tool: ToolName;
  scope: Scope;
  rule: Partial<ToolRule>;
}

export interface Assignment {
  profileId: ProfileId;
  exceptions: Exception[];
  onScreenOnly: boolean;
  applyNative?: boolean;
  /** Non-default points only: `${tool}.${field}` keys chosen explicitly. See docs/plans/2026-11-14-policy-permissions-machinery.plan.md, "Third pass rulings". */
  pinned?: readonly string[];
}

export type AssignmentPoint =
  | { kind: 'session'; sessionId: string }
  | { kind: 'peer'; machineId: string }
  | { kind: 'cli'; cli: CliKind }
  | { kind: 'default' };

export type Principal =
  | {
      kind: 'session';
      sessionId: string;
      generation?: number;
      handle: string;
      launchedCli: CliKind | null;
      homeFolder: string | null;
      projectId: string | null;
    }
  | (RemotePrincipal & { capabilities: Capabilities });

export interface PolicyTarget {
  sessionId: string | null;
  /** The exact file or folder acted on ("this target only"). */
  path: string | null;
  /** The folder the target lives in: a session's cwd, a file's parent, a folder itself ("this folder"). */
  folder: string | null;
  projectId: string | null;
}

export type GrantWho =
  | { kind: 'session'; sessionId: string }
  | { kind: 'cli'; cli: CliKind }
  | { kind: 'peer'; machineId: string };
export type GrantFor = 'session-end' | '1h' | '24h' | 'until-revoked';
export type GrantState = 'active' | 'suspended' | 'expired' | 'revoked';

export interface Grant {
  id: string;
  who: GrantWho;
  tool: ToolName;
  on: Scope;
  for: GrantFor;
  /** The requester session whose end expires a 'session-end' grant. */
  anchorSessionId: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastConsentedAt?: string;
  useCount?: number;
  lifecycleRevision?: number;
  state: GrantState;
  endedAt: string | null;
  requestId: string | null;
}

export interface SessionDenial {
  id: string;
  requestId: string;
  sessionId: string;
  tool: ToolName;
  createdAt: string;
}

export interface ActivityReceipt {
  id: string;
  at: string;
}

export interface OneUseOverride {
  generation?: number;
  id: string;
  sessionId: string;
  tool: ToolName;
  target: PolicyTarget;
  createdAt: string;
}

export type FloorId = 'master-off' | 'remote-capability' | 'local-to-you';

export type Reason =
  | { by: 'floor'; floor: FloorId }
  | { by: 'deny'; point: AssignmentPoint }
  | { by: 'session-deny'; denialId: string }
  | { by: 'override'; overrideId: string }
  | { by: 'grant'; grantId: string }
  | { by: 'exception'; point: AssignmentPoint; profileId: ProfileId }
  | { by: 'profile'; point: AssignmentPoint; profileId: ProfileId };

export interface PolicyState {
  /** Human-made copies only; built-ins come from policy-profiles.ts. */
  profiles: readonly Profile[];
  /** Keyed by pointKey(point). */
  assignments: ReadonlyMap<string, Assignment>;
  grants: readonly Grant[];
  overrides: readonly OneUseOverride[];
  sessionDenials: readonly SessionDenial[];
  /** see POL §5: an unreadable policy with no saved copy makes every principal Observer. */
  failClosed: boolean;
}

export interface PolicyInput {
  principal: Principal;
  tool: ToolName;
  targets: readonly PolicyTarget[];
  masterOn: boolean;
  toYou: boolean;
  now: number;
  heldOverrides?: readonly OneUseOverride[];
  /**
   * The call's target must be asked about whatever the profile allows: a machine that was never
   * added (spec 4.6, RS-D6). Computed from the facts by policy-targets' forcesAsk.
   */
  forceAsk?: boolean;
}

export interface PolicyDecision {
  decision: Decision;
  reason: Reason;
  rule: { when: When | null; reach: Reach | null; move: Move | null };
  grantId: string | null;
  grantIds: readonly string[];
  overrideId: string | null;
  overrideIds: readonly string[];
  deniedTarget: PolicyTarget | null;
  /** The ask is a forced one (RS-D6): no grant can pass it, so the card offers no Always. */
  forcedAsk: boolean;
}

export type PermissionAnswer =
  | { outcome: 'allowed'; grant?: GrantChoice }
  | { outcome: 'denied'; reason?: string; scope?: 'session' };

export type PolicyEditError =
  | 'conflict'
  | 'invalid-value'
  | 'unknown-profile'
  | 'read-only'
  | 'save-failed'
  | 'too-large'
  | 'not-found'
  | 'no-copy'
  | 'busy'
  | 'native-review-required';
export type PolicyEditResult =
  | { ok: true }
  | { ok: false; error: PolicyEditError; applied?: 'tightening' };
export type PolicyCommitError = 'policy-changed' | 'save-failed' | 'too-large' | 'read-only';
export type PolicyCommitResult =
  | { ok: true; overrides: OneUseOverride[] }
  | { ok: false; error: PolicyCommitError };
export type GrantLifecycleResult =
  | { ok: true; undoToken?: string }
  | { ok: false; error: PolicyEditError; applied?: 'tightening' };

export type GrantBatchResult =
  | { ok: true; grants: Grant[] }
  | { ok: false; error: PolicyEditError };

export interface MigrationSummaryRow {
  provenance?: 'resolved-global';
  point:
    | { kind: 'default' }
    | { kind: 'cli'; cli: CliKind }
    | { kind: 'session'; sessionId: string };
  fields: Array<{ tool: ToolName; field: 'access' | 'when' | 'reach' | 'move'; value: string }>;
  profileId: 'worker' | 'lead';
  exceptions: number;
  onScreenOnly: boolean;
}

// see plan C8
export interface PolicyUiState {
  migration?: {
    migratedFrom: 'v0.64';
    offeredSessionIds: string[];
    acknowledged: boolean;
    summary?: MigrationSummaryRow[];
    summaryTruncated?: boolean;
  } | null;
  editToken: string;
  saveError: string | null;
  backupWarning: string | null;
  profiles: Profile[];
  assignments: Array<{ point: AssignmentPoint; assignment: Assignment }>;
  sessions: Record<
    string,
    {
      profileId: ProfileId;
      sourcePoint: AssignmentPoint;
      inheritedPoint: AssignmentPoint;
      inheritedProfileId: ProfileId;
      launchedCli: CliKind | null;
      profileName: string;
      exceptions: number;
      source: 'session' | 'cli' | 'default';
      label: string | null;
    }
  >;
  grants: Array<Grant & { expiring: boolean }>;
  /** DN-2: the legacy editors read this projection, not the assignments. */
  legacy: { global: PolicyLayer; byCli: CliPolicyLayers; sessions: Record<string, PolicyLayer> };
  readOnly: boolean;
}

export type LocalPolicyEdit =
  | { kind: 'assignment'; point: AssignmentPoint; assignment: Assignment | null }
  | { kind: 'profile'; profile: Profile }
  | { kind: 'delete-profile'; profileId: ProfileId; replacement: ProfileId };
export interface ProfileReviewDisplay {
  before: Profile | null;
  after: Profile;
  optedInPoints: AssignmentPoint[];
  affectedSessions: Array<{
    sessionId: string;
    family: 'claude' | 'codex';
    point: AssignmentPoint;
  }>;
  truncated: boolean;
}
export type LocalPolicyReviewResult =
  | { ok: true; requiresNativeReview: false; profileDisplay?: ProfileReviewDisplay }
  | { ok: true; requiresNativeReview: true; digest: string; profileDisplay?: ProfileReviewDisplay }
  | { ok: false; error: PolicyEditError };

export interface ActivityDecisionTraceV1 {
  v: 1;
  decidedAt: string;
  facts: {
    v: 1;
    principal:
      | {
          kind: 'session';
          sessionId: string;
          launchedCli: CliKind | null;
          generation: number | null;
          projectId: string | null;
        }
      | {
          kind: 'remote';
          machineId: string;
          handle: string;
          trust: 'own';
          controller: boolean;
          capabilities: Capabilities;
        };
    tool: ToolName;
    targets: readonly PolicyTarget[];
    masterOn: boolean;
    toYou: boolean;
    forceAsk: boolean;
  };
  decision: Decision;
  reason: Reason;
  rule: PolicyDecision['rule'];
  forcedAsk: boolean;
  assignment: { point: AssignmentPoint; profileId: ProfileId; profileName: string } | null;
  runtime: { outcome: 'not-reached' | 'proceeded' | 'refused' | 'unknown'; code: null };
  stages: readonly ('floors' | 'explicit-deny' | 'grants' | 'assignment')[];
  withoutWinner: { decision: Decision; reason: Reason } | null;
  winnerDigest?: string;
}

export type PreviewDraft = { point: AssignmentPoint; assignment: Assignment | null };
export type PreviewResult =
  | { ok: true; decision: PolicyDecision; editToken: string; runtime: 'unevaluated' }
  | { ok: false; error: 'conflict' | 'invalid-value' | 'read-only' | 'not-found' };
export type ReplayResult =
  | {
      ok: true;
      editToken: string;
      sampled: number;
      changed: number;
      skipped: { aggregate: number; legacy: number; incomplete: number; remote: number };
      truncated: boolean;
      since: string;
    }
  | { ok: false; error: 'conflict' | 'invalid-value' | 'read-only' | 'unavailable' };

export type PreviewIntent =
  | { tool: 'close_session'; targetSessionId: string }
  | { tool: 'open_file'; path: string };
