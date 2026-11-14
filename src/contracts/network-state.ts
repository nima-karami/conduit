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
