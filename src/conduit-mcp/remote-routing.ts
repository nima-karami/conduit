// Node-free. The MCP host reads remote sessions through NetworkPort; the directory implementation
// lives in src/network/remote-directory.ts. Plan: 2026-11-14-conduit-network-machinery.plan.md, Slice 5.

import type { Capabilities, MonitorSnapshot } from '../contracts/link-protocol';
import { parseAddress } from '../network/addresses';
import type { WaitReading } from './session-waits';
import type { DirectoryEntry } from './tools';
import { type Handle, type MessageRecord, type ToolError, toolError } from './types';

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

/** Implemented by the mcp host; read by server/network. Slice 6 adds its members here. */
export interface McpNetworkPort {
  localDirectory(): DirectoryEntry[];
  youUnread(): number;
  ownerPresence(): 'here' | 'away';
  requestsSummary(): MonitorSnapshot['requests'];
}

/** A control tool target naming another machine: orchestrate is v1 (NET §4.1), so say so plainly. */
export function remoteTargetRefusal(target: string): ToolError | null {
  const parsed = parseAddress(target);
  if (parsed === null || parsed.machine === null) return null;
  return toolError(
    'peer_unsupported',
    `${target} is on another machine; opening, typing into or reading sessions on other machines isn't available yet`,
    undefined,
    { hint: 'message it with send_message instead' },
  );
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
