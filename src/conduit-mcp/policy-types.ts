// Node-free: the renderer imports these. See spec 2026-11-14-policy-and-permissions §4.

import type { Capabilities, RemotePrincipal } from '../contracts/remote-principal';
import type { CliKind, Move, Reach, ToolName, When } from './tool-policy';

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
  state: GrantState;
  endedAt: string | null;
  requestId: string | null;
}

export interface OneUseOverride {
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
}

export interface PolicyInput {
  principal: Principal;
  tool: ToolName;
  targets: readonly PolicyTarget[];
  masterOn: boolean;
  toYou: boolean;
  now: number;
}

export interface PolicyDecision {
  decision: Decision;
  reason: Reason;
  rule: { when: When | null; reach: Reach | null; move: Move | null };
  grantId: string | null;
  overrideId: string | null;
}
