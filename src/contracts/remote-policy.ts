// Node-free: the renderer may show these. See plan 2026-11-16-remote-ssh-rules, Technical decisions 1.
import type { Assignment, Grant, Profile } from '../conduit-mcp/policy-types';
import type { CliKind } from '../conduit-mcp/tool-policy';

/** Where a portable assignment sits. Session points never travel: their ids are local to one machine. */
export type RemotePolicyPoint =
  | { kind: 'default' }
  | { kind: 'cli'; cli: CliKind }
  | { kind: 'peer'; machineId: string };

/** The part of a machine's policy that travels: profiles plus non-session assignments. */
export interface RemotePolicyDoc {
  profiles: Profile[];
  assignments: Array<{ point: RemotePolicyPoint; assignment: Assignment }>;
}

/** A grant as the controller sees it. `who` is a display string, never an identity to parse back. */
export type RemoteGrantView = Pick<
  Grant,
  'id' | 'tool' | 'on' | 'for' | 'createdAt' | 'expiresAt' | 'lastUsedAt'
> & { who: string };

export interface RemotePolicySnapshot {
  rev: number;
  doc: RemotePolicyDoc;
  grants: RemoteGrantView[];
}

// The caps are enforced on the machine that owns the policy: a controller cannot push past them.
export const REMOTE_POLICY_DOC_MAX_BYTES = 256 * 1024;
export const REMOTE_POLICY_PROFILES_MAX = 64;
export const REMOTE_POLICY_ASSIGNMENTS_MAX = 256;
export const REMOTE_POLICY_NAME_MAX = 80;
export const REMOTE_POLICY_EXCEPTIONS_MAX = 64;
export const REMOTE_POLICY_PATH_MAX = 1024;
