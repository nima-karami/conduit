// Node-free. The MCP host reads remote sessions through NetworkPort; the directory implementation
// lives in src/network/remote-directory.ts. Plan: 2026-11-14-conduit-network-machinery.plan.md, Slice 5.

import type { Capabilities } from '../contracts/link-protocol';
import type { WaitReading } from './session-waits';
import type { DirectoryEntry } from './tools';
import type { Handle, MessageRecord } from './types';

export interface RemoteEntry extends DirectoryEntry {
  /** Canonical 'handle@m-xxxxxxxx'. */
  address: string;
  /** Shown form 'handle@<machine name>'. */
  display: string;
  machineId: string;
  machine: string;
  trust: 'own';
  link: 'up' | 'degraded' | 'down';
}

export type RemoteResolution =
  | { kind: 'local'; handle: Handle }
  | { kind: 'remote'; entry: RemoteEntry }
  | { kind: 'unknown'; hint: string };

export interface RemoteRecipientOutcome {
  address: string;
  status: 'queued' | 'refused';
  reason: 'peer_unreachable' | 'peer_revoked' | 'peer_incompatible' | 'capability_off' | null;
}

export interface NetworkPort {
  remoteEntries(): RemoteEntry[];
  resolve(target: string): RemoteResolution;
  enqueue(msg: MessageRecord, recipients: RemoteEntry[]): RemoteRecipientOutcome[];
  waitReading(address: string, callerHandle: Handle): WaitReading | 'unreachable' | null;
  capabilitiesOf(machineId: string): Capabilities | null;
  onChange(listener: () => void): () => void;
}

/** Local rows keep their order and come first, so a bare handle still finds its local session. */
export function mergeDirectory(
  local: DirectoryEntry[],
  remote: RemoteEntry[],
): (DirectoryEntry | RemoteEntry)[] {
  return [...local, ...remote];
}

export function isRemote(e: DirectoryEntry | RemoteEntry): e is RemoteEntry {
  return 'address' in e;
}
