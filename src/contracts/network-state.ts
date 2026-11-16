import type { Capabilities, LinkFeature, LinkState, MonitorSnapshot } from './link-protocol';
import type { MachineView } from './machines';
// The renderer's view of network pairing. Link views are added to this file by later tasks.

export type PairingViewState =
  | 'showing-code'
  | 'connecting'
  | 'confirm'
  | 'waiting-peer'
  | 'done'
  | 'expired'
  | 'used'
  | 'wrong-code'
  | 'mismatch'
  | 'declined'
  | 'unreachable'
  | 'different-owner'
  | 'incompatible'
  | 'failed'
  | 'cancelled';

export interface NetworkPairingView {
  pairingId: string;
  role: 'opener' | 'joiner';
  state: PairingViewState;
  code: [string, string, string] | null;
  expiresAt: string | null;
  fingerprint: string | null;
  peerName: string | null;
  peerMachineId: string | null;
}

/** One linked machine as C2 reports it (link.list, network.changed). */
export interface NetworkLinkView {
  machineId: string;
  name: string;
  trust: 'own';
  /** How the link reaches the peer: TLS over the link port, or an ssh child's stdio. */
  transport: 'tls' | 'ssh';
  state: LinkState;
  since: string;
  /** Set once a revoke happened this run: 'me' here, 'peer' when the other side revoked. */
  revokedBy: 'me' | 'peer' | null;
  addresses: string[];
  capabilities: Capabilities;
  peerCapabilities: Capabilities | null;
  unsupported: LinkFeature[];
  fingerprint: string;
  lastActivity: string | null;
  /** The peer's last monitor push (Slice 5); null until one arrives. */
  snapshot: MonitorSnapshot | null;
}

export interface NetworkState {
  machineId: string;
  selfName: string;
  listening: string[];
  links: NetworkLinkView[];
  pairing: NetworkPairingView | null;
  /** Added ssh machines (the slice 4 registry), for the Machines UI. */
  machines: MachineView[];
}
