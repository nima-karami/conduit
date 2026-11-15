import type { MessageKind, Priority } from '../conduit-mcp/types';
import { OUTBOX_TTL_MS, type WireMessage } from '../contracts/link-protocol';
import { judgePersistedVersion, SERVER_FILE_VERSION } from '../contracts/session-identity';

export interface OutboxEntry {
  machineId: string;
  message: WireMessage;
  /** canonical 'handle@m-…' recipients on that machine */
  addresses: string[];
  /** Blob content addresses in the local message store, never inline bytes. */
  attachmentRefs?: { sha256: string; name: string; mime: string }[];
  enqueuedAt: number;
  state: 'queued' | 'sent';
}

/** Most entries one outbox holds; past it, new sends are refused, not dropped (CON-27 review, minor 6). */
export const OUTBOX_MAX_ENTRIES = 1000;
/** Most serialized bytes one outbox holds, summed over its entries. */
export const OUTBOX_MAX_BYTES = 64 * 1024 * 1024;

export interface Outbox {
  /**
   * FIFO per machine; a duplicate messageId for the same machine is ignored. False when the entry
   * would pass OUTBOX_MAX_ENTRIES or OUTBOX_MAX_BYTES; nothing is stored then.
   */
  enqueue(e: Omit<OutboxEntry, 'state'>): boolean;
  /** Every 'queued' entry for that machine, marked 'sent'. A second call returns nothing new. */
  batchFor(machineId: string): OutboxEntry[];
  /** Sent entries go back to queued in their original order: the link dropped before the ack. */
  onDown(machineId: string): void;
  /** Removes and returns the entry; an unknown id is null. */
  ack(machineId: string, messageId: string): OutboxEntry | null;
  /** Removes and returns entries that have lived for the whole TTL. */
  expire(now: number): OutboxEntry[];
  /** Removes and returns all of one machine's entries, when its link is revoked. */
  revoke(machineId: string): OutboxEntry[];
  entries(): OutboxEntry[];
  /** Entries for the machine that are still waiting for an ack, queued or sent. */
  pending(machineId: string): number;
}

// see docs/plans/2026-11-14-conduit-network-machinery.plan.md, Technical decisions 8
const encoder = new TextEncoder();

/** An entry with its serialized size, fixed when it is stored: the cap counts what was admitted. */
interface Slot {
  entry: OutboxEntry;
  bytes: number;
}

export function createOutbox(initial: OutboxEntry[]): Outbox {
  let slots: Slot[] = [];
  let usedBytes = 0;

  const sameMessage = (e: OutboxEntry, machineId: string, messageId: string) =>
    e.machineId === machineId && e.message.messageId === messageId;

  const slotOf = (e: OutboxEntry): Slot => {
    const entry = copyEntry(e);
    return { entry, bytes: encoder.encode(JSON.stringify(entry)).byteLength };
  };

  const store = (slot: Slot) => {
    slots.push(slot);
    usedBytes += slot.bytes;
  };

  const removeWhere = (pred: (e: OutboxEntry) => boolean): OutboxEntry[] => {
    const removed = slots.filter((s) => pred(s.entry));
    slots = slots.filter((s) => !pred(s.entry));
    for (const s of removed) usedBytes -= s.bytes;
    return removed.map((s) => copyEntry(s.entry));
  };

  // A load keeps what was persisted, even past the caps: the caps only refuse new sends.
  for (const e of initial) {
    const fresh = { ...e, state: 'queued' as const };
    if (!slots.some((s) => sameMessage(s.entry, fresh.machineId, fresh.message.messageId)))
      store(slotOf(fresh));
  }

  return {
    enqueue(e) {
      const fresh = { ...e, state: 'queued' as const };
      if (slots.some((s) => sameMessage(s.entry, fresh.machineId, fresh.message.messageId)))
        return true;
      const slot = slotOf(fresh);
      if (slots.length >= OUTBOX_MAX_ENTRIES || usedBytes + slot.bytes > OUTBOX_MAX_BYTES)
        return false;
      store(slot);
      return true;
    },
    batchFor(machineId) {
      const batch: OutboxEntry[] = [];
      for (const { entry: e } of slots) {
        if (e.machineId !== machineId || e.state !== 'queued') continue;
        e.state = 'sent';
        batch.push(copyEntry(e));
      }
      return batch;
    },
    onDown(machineId) {
      for (const { entry: e } of slots) {
        if (e.machineId === machineId && e.state === 'sent') e.state = 'queued';
      }
    },
    ack(machineId, messageId) {
      const i = slots.findIndex((s) => sameMessage(s.entry, machineId, messageId));
      if (i === -1) return null;
      const [removed] = slots.splice(i, 1);
      usedBytes -= removed.bytes;
      return copyEntry(removed.entry);
    },
    expire(now) {
      return removeWhere((e) => now - e.enqueuedAt >= OUTBOX_TTL_MS);
    },
    revoke(machineId) {
      return removeWhere((e) => e.machineId === machineId);
    },
    entries() {
      return slots.map((s) => copyEntry(s.entry));
    },
    pending(machineId) {
      return slots.filter((s) => s.entry.machineId === machineId).length;
    },
  };
}

function copyEntry(e: OutboxEntry): OutboxEntry {
  return {
    ...e,
    addresses: [...e.addresses],
    ...(e.attachmentRefs ? { attachmentRefs: e.attachmentRefs.map((a) => ({ ...a })) } : {}),
    message: {
      ...e.message,
      to: [...e.message.to],
      attachments: e.message.attachments.map((a) => ({ ...a })),
    },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isMachineId = (v: unknown): v is string => isStr(v) && /^m-[0-9a-f]{8}$/.test(v);

// Records, not arrays, so adding a kind or priority to the contract fails to compile here.
const MESSAGE_KINDS: Record<MessageKind, true> = {
  inform: true,
  request: true,
  question: true,
  done: true,
};
const PRIORITIES: Record<Priority, true> = { fyi: true, normal: true, urgent: true };
const isKind = (v: unknown): v is MessageKind => isStr(v) && Object.hasOwn(MESSAGE_KINDS, v);
const isPriority = (v: unknown): v is Priority => isStr(v) && Object.hasOwn(PRIORITIES, v);

const isAttachment = (v: unknown): boolean =>
  isObj(v) && isStr(v.name) && isStr(v.mime) && isStr(v.data);

const isWireMessage = (v: unknown): v is WireMessage =>
  isObj(v) &&
  isStr(v.messageId) &&
  isStr(v.threadId) &&
  isStr(v.from) &&
  Array.isArray(v.to) &&
  v.to.every(isStr) &&
  isStr(v.subject) &&
  isKind(v.kind) &&
  isPriority(v.priority) &&
  isStr(v.sentAt) &&
  isStr(v.body) &&
  Array.isArray(v.attachments) &&
  v.attachments.every(isAttachment);

const isBlobRef = (v: unknown): boolean =>
  isObj(v) && isStr(v.sha256) && /^[0-9a-f]{64}$/.test(v.sha256) && isStr(v.name) && isStr(v.mime);

const isEntry = (v: unknown): v is OutboxEntry =>
  isObj(v) &&
  isMachineId(v.machineId) &&
  isWireMessage(v.message) &&
  Array.isArray(v.addresses) &&
  v.addresses.every(isStr) &&
  (v.attachmentRefs === undefined ||
    (Array.isArray(v.attachmentRefs) && v.attachmentRefs.every(isBlobRef))) &&
  typeof v.enqueuedAt === 'number' &&
  Number.isFinite(v.enqueuedAt) &&
  (v.state === 'queued' || v.state === 'sent');

export function parseOutboxFile(
  text: string,
): { kind: 'ok'; entries: OutboxEntry[] } | { kind: 'newer' } | { kind: 'corrupt' } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isObj(raw)) return { kind: 'corrupt' };
  const verdict = judgePersistedVersion('network/outbox.json', raw.version);
  if (verdict === 'newer') return { kind: 'newer' };
  if (verdict === 'invalid') return { kind: 'corrupt' };
  if (!Array.isArray(raw.entries) || !raw.entries.every(isEntry)) return { kind: 'corrupt' };
  return { kind: 'ok', entries: raw.entries };
}

export function serializeOutboxFile(entries: OutboxEntry[]): string {
  return `${JSON.stringify({ version: SERVER_FILE_VERSION['network/outbox.json'], entries })}\n`;
}
