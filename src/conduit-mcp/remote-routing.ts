// Node-free. The MCP host reads remote sessions through NetworkPort; the directory implementation
// lives in src/network/remote-directory.ts. Plan: 2026-11-14-conduit-network-machinery.plan.md, Slice 5.

import type {
  Capabilities,
  MonitorSnapshot,
  WireRecipientOutcome,
} from '../contracts/link-protocol';
import { parseAddress } from '../network/addresses';
import type { WaitReading } from './session-waits';
import type { DirectoryEntry } from './tools';
import {
  type Handle,
  type MessageRecord,
  type RecipientStatus,
  type ToolError,
  toolError,
} from './types';

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
  reason:
    | 'peer_unreachable'
    | 'peer_revoked'
    | 'peer_incompatible'
    | 'capability_off'
    | 'outbox_full'
    | null;
}

export interface NetworkPort {
  remoteEntries(): RemoteEntry[];
  resolve(target: string): RemoteResolution;
  enqueue(msg: MessageRecord, recipients: RemoteEntry[]): RemoteRecipientOutcome[];
  waitReading(address: string, callerHandle: Handle): WaitReading | 'unreachable' | null;
  /** What that machine lets me do (its record of the link), not what I let it do. */
  peerCapabilitiesOf(machineId: string): Capabilities | null;
  onChange(listener: () => void): () => void;
}

/** Implemented by the mcp host; read by server/network. Slice 6 adds its members here. */
export interface McpNetworkPort {
  localDirectory(): DirectoryEntry[];
  hasMessage(messageId: string): boolean;
  readBlob(sha256: string): Promise<Uint8Array | undefined>;
  /**
   * Stores a message that arrived over a link for the local handles in msg.to it may reach; one
   * outcome per msg.to entry, in order. Resolves only after the append is durable, so the caller
   * acks nothing it could still lose. Rejects when the store cannot write (the caller retries).
   */
  deliverInbound(
    msg: MessageRecord & { origin: string },
    blobs: { name: string; mime: string; bytes: Buffer }[],
    framedAsHuman: boolean,
  ): Promise<WireRecipientOutcome[]>;
  /** True when the local thread already carried a message to a recipient on that machine. */
  threadExportedTo(threadId: string, machineId: string): boolean;
  /**
   * The thread id that machine knows a local thread by: the wire id it sent when the thread came
   * from there (MessageRecord.originThreadId), otherwise the local id. CON-27 review B1.
   */
  wireThreadFor(threadId: string, machineId: string): string;
  /** A receipt or failure for a remote recipient of a message sent from here. */
  setRemoteStatus(messageId: string, address: string, status: RecipientStatus): Promise<void>;
  /**
   * Fires when a local recipient of a message that came over a link is noticed or reads it.
   * `messageId` is the origin's own (wire) id, MessageRecord.originMessageId, never the local one.
   */
  onLocalStatus(
    listener: (
      messageId: string,
      handle: Handle,
      status: 'noticed' | 'read',
      origin: string,
    ) => void,
  ): () => void;
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
