import type { MessageKind, Priority } from '../conduit-mcp/types';
import { OUTBOX_TTL_MS, type WireMessage } from '../contracts/link-protocol';
import { judgePersistedVersion } from '../contracts/session-identity';

export interface OutboxEntry {
  machineId: string;
  message: WireMessage;
  /** canonical 'handle@m-…' recipients on that machine */
  addresses: string[];
  enqueuedAt: number;
  state: 'queued' | 'sent';
}

export interface Outbox {
  /** FIFO per machine; a duplicate messageId for the same machine is ignored. */
  enqueue(e: Omit<OutboxEntry, 'state'>): void;
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
export function createOutbox(initial: OutboxEntry[]): Outbox {
  let list: OutboxEntry[] = [];

  const sameMessage = (e: OutboxEntry, machineId: string, messageId: string) =>
    e.machineId === machineId && e.message.messageId === messageId;

  const insert = (e: OutboxEntry) => {
    if (list.some((o) => sameMessage(o, e.machineId, e.message.messageId))) return;
    list.push(copyEntry(e));
  };

  const removeWhere = (pred: (e: OutboxEntry) => boolean): OutboxEntry[] => {
    const removed = list.filter(pred);
    list = list.filter((e) => !pred(e));
    return removed.map(copyEntry);
  };

  for (const e of initial) insert({ ...e, state: 'queued' });

  return {
    enqueue(e) {
      insert({ ...e, state: 'queued' });
    },
    batchFor(machineId) {
      const batch: OutboxEntry[] = [];
      for (const e of list) {
        if (e.machineId !== machineId || e.state !== 'queued') continue;
        e.state = 'sent';
        batch.push(copyEntry(e));
      }
      return batch;
    },
    onDown(machineId) {
      for (const e of list) {
        if (e.machineId === machineId && e.state === 'sent') e.state = 'queued';
      }
    },
    ack(machineId, messageId) {
      const i = list.findIndex((e) => sameMessage(e, machineId, messageId));
      if (i === -1) return null;
      const [removed] = list.splice(i, 1);
      return copyEntry(removed);
    },
    expire(now) {
      return removeWhere((e) => now - e.enqueuedAt >= OUTBOX_TTL_MS);
    },
    revoke(machineId) {
      return removeWhere((e) => e.machineId === machineId);
    },
    entries() {
      return list.map(copyEntry);
    },
    pending(machineId) {
      return list.filter((e) => e.machineId === machineId).length;
    },
  };
}

function copyEntry(e: OutboxEntry): OutboxEntry {
  return {
    ...e,
    addresses: [...e.addresses],
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

const isEntry = (v: unknown): v is OutboxEntry =>
  isObj(v) &&
  isMachineId(v.machineId) &&
  isWireMessage(v.message) &&
  Array.isArray(v.addresses) &&
  v.addresses.every(isStr) &&
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
  return `${JSON.stringify({ version: 1, entries })}\n`;
}
