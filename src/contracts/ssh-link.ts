import type { Duplex } from 'node:stream';

// see docs/plans/2026-11-16-remote-ssh-stdio-link.plan.md §Contracts: shared by the link manager, the ssh
// dialer, the bridge and the stdio-link endpoint, which are built in parallel lanes.

/** How the controller reaches a remote server; slice 3's probe fills it. */
export interface SshEndpoint {
  target: string;
  node: string;
  mainJs: string;
  userData: string;
}

export type SshNeedsPersonReason =
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'passphrase'
  | 'password'
  | 'mfa';

export type SshFailure =
  | { code: 'ssh_needs_person'; reason: SshNeedsPersonReason }
  | { code: 'ssh_unreachable'; detail: string }
  | { code: 'ssh_auth_failed' }
  | { code: 'bridge_no_server' }
  | { code: 'bridge_no_secret' }
  | { code: 'bridge_refused' }
  | { code: 'ssh_failed'; detail: string };

export interface SshDialed {
  stream: Duplex;
  /** Settles after the ssh child exits; null when it exited cleanly. */
  failure(): Promise<SshFailure | null>;
}

export type SshDial = (ssh: SshEndpoint) => SshDialed;

/** The bridge's one preamble frame is tiny; a larger one is not a bridge. */
export const BRIDGE_PREAMBLE_MAX_BYTES = 1024;

export interface BridgePreamble {
  t: 'bridge';
  v: 1;
  secret: string;
}

export const BRIDGE_EXIT_CODE = 3;

export type BridgeFailureCode = 'no_secret' | 'no_server' | 'refused';

export type AddSshPeerResult =
  | { ok: true; machineId: string }
  | {
      ok: false;
      error:
        | SshFailure
        | { code: 'identity-changed' }
        | { code: 'identity-conflict' }
        | { code: 'bad-hello' }
        | { code: 'incompatible' }
        | { code: 'timeout' };
    };
