import type { LinkState } from './link-protocol';

export type MachineMode = 'full' | 'light';
export interface MachineMeta {
  os: 'linux' | 'windows';
  arch: 'x64';
  version: string;
  mode: MachineMode;
  agents: string[];
  enabled: boolean;
  /** null: the machine was never bootstrapped by us, so the install's answer is not known. */
  survivesLogout: boolean | null;
}
export type MachineState = LinkState | 'disabled';
export interface MachineView {
  machine: string;
  machine_id: string;
  target: string;
  state: MachineState;
  mode: MachineMode | null;
  os: string | null;
  arch: string | null;
  conduit_version: string | null;
  agents: string[];
  sessions: number;
  last_seen: string | null;
  survives_logout: boolean | null;
}
export interface ConnectMachineOk {
  machine: string;
  machine_id: string;
  state: 'up';
  os: string;
  arch: string;
  mode: MachineMode;
  conduit_version: string;
  reused: boolean;
  installed: boolean;
  upgraded: boolean;
}
export type MachineErrorCode =
  | 'machine_unknown'
  | 'ssh_needs_person'
  | 'ssh_unreachable'
  | 'ssh_auth_failed'
  | 'remote_unsupported'
  | 'install_failed'
  | 'identity_changed'
  | 'identity_conflict'
  | 'peer_incompatible';
export interface MachineError {
  code: MachineErrorCode;
  detail: Record<string, string | null>;
  candidates?: string[];
}
export type ConnectMachineResult =
  | { ok: true; value: ConnectMachineOk }
  | { ok: false; error: MachineError };
export type DisconnectMachineResult =
  | { ok: true; value: { machine: string; state: 'down' } }
  | { ok: false; error: MachineError };
