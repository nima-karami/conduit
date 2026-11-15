import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../src/atomic-write';
import { MAX_MESSAGE_ATTACHMENT_BYTES } from '../../src/conduit-mcp/attachments';
import type {
  McpNetworkPort,
  RemoteEntry,
  RemoteRecipientOutcome,
} from '../../src/conduit-mcp/remote-routing';
import { MAX_BODY_BYTES } from '../../src/conduit-mcp/tools';
import type { MessageRecord } from '../../src/conduit-mcp/types';
import type {
  Capabilities,
  LinkFrame,
  LinkState,
  WireMessage,
  WireRecipientOutcome,
} from '../../src/contracts/link-protocol';
import { formatAddress } from '../../src/network/addresses';
import {
  createOutbox,
  type Outbox,
  type OutboxEntry,
  parseOutboxFile,
  serializeOutboxFile,
} from '../../src/network/outbox';
import type { AuditSink } from './audit-log';

// Cross-machine messages, exactly once (plan decision 8). The sender keeps a persisted FIFO outbox
// per machine and resends what isn't acked whenever the link comes up; the receiver dedupes by
// message id against its own message store, which is durable in the same write as delivery.
// Receipts flow back best effort. Routing is non-transitive: only messages that started here go out.

export interface MessagingLink {
  machineId: string;
  state: LinkState;
  /** What I enable on this link. */
  capabilities: Capabilities;
  /** What the peer enables toward me; null until its hello. */
  peerCapabilities: Capabilities | null;
}

export interface MessagingDeps {
  /** <userData>/network/outbox.json */
  file: string;
  machineId(): string;
  links(): MessagingLink[];
  send(machineId: string, frame: LinkFrame): boolean | null;
  mcp(): McpNetworkPort | null;
  audit: AuditSink;
  log: {
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
  now(): number;
  /** Runs fn after ms; returns its cancel. */
  after(fn: () => void, ms: number): () => void;
}

export interface Messaging {
  start(): void;
  stop(): void;
  enqueue(msg: MessageRecord, recipients: RemoteEntry[]): RemoteRecipientOutcome[];
  /** A link came up: resend its queue and the receipts held for it. */
  linkUp(machineId: string): void;
  linkDown(machineId: string): void;
  revoked(machineId: string): void;
  onFrame(machineId: string, frame: Extract<LinkFrame, { t: 'msg' | 'ack' | 'receipt' }>): void;
}

const EXPIRE_EVERY_MS = 60_000;
const TERMINAL: readonly LinkState[] = ['revoked', 'incompatible', 'identity-changed'];
const live = (s: LinkState) => s === 'up' || s === 'degraded';

function loadOutbox(
  file: string,
  log: MessagingDeps['log'],
): { outbox: Outbox; writable: boolean } {
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  if (text === null) return { outbox: createOutbox([]), writable: true };
  const parsed = parseOutboxFile(text);
  if (parsed.kind === 'ok') return { outbox: createOutbox(parsed.entries), writable: true };
  if (parsed.kind === 'newer') {
    log.error('outbox.json is from a newer version; queued messages are kept but not sent', {
      file,
    });
    return { outbox: createOutbox([]), writable: false };
  }
  log.error('outbox.json is corrupt; queued messages were lost', { file });
  return { outbox: createOutbox([]), writable: true };
}

export function createMessaging(deps: MessagingDeps): Messaging {
  const { outbox, writable } = loadOutbox(deps.file, deps.log);
  /** Receipts owed to a machine whose link is down: held until it is up again. */
  const heldReceipts = new Map<string, Extract<LinkFrame, { t: 'receipt' }>[]>();
  let stopExpiry: (() => void) | null = null;
  let offLocalStatus: (() => void) | null = null;

  const persist = (): void => {
    if (!writable) return;
    try {
      fs.mkdirSync(path.dirname(deps.file), { recursive: true, mode: 0o700 });
      // Owner-only: the outbox holds message bodies on their way to another machine.
      atomicWriteFileSync(deps.file, serializeOutboxFile(outbox.entries()), fs, { mode: 0o600 });
    } catch (err) {
      deps.log.error('outbox write failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const linkOf = (machineId: string) => deps.links().find((l) => l.machineId === machineId) ?? null;

  const markRemote = async (
    entry: OutboxEntry,
    status: 'undelivered' | 'expired',
  ): Promise<void> => {
    const mcp = deps.mcp();
    for (const address of entry.addresses)
      await mcp?.setRemoteStatus(entry.message.messageId, address, status);
  };

  const flush = (machineId: string): void => {
    for (const entry of outbox.batchFor(machineId)) {
      if (deps.send(machineId, { t: 'msg', message: entry.message }) === null) {
        outbox.onDown(machineId);
        break;
      }
    }
  };

  const sendReceipt = (machineId: string, frame: Extract<LinkFrame, { t: 'receipt' }>): void => {
    const link = linkOf(machineId);
    if (link && live(link.state) && deps.send(machineId, frame) !== null) return;
    const held = heldReceipts.get(machineId) ?? [];
    held.push(frame);
    heldReceipts.set(machineId, held);
  };

  const expire = (): void => {
    const gone = outbox.expire(deps.now());
    if (gone.length > 0) {
      for (const e of gone)
        void markRemote(e, 'expired').catch((err: unknown) =>
          deps.log.error('expiry status failed', { message: String(err) }),
        );
      persist();
    }
    stopExpiry = deps.after(expire, EXPIRE_EVERY_MS);
  };

  const ack = async (
    machineId: string,
    messageId: string,
    recipients: WireRecipientOutcome[],
  ): Promise<void> => {
    if (
      !outbox.entries().some((e) => e.machineId === machineId && e.message.messageId === messageId)
    )
      return;
    const mcp = deps.mcp();
    if (mcp === null && recipients.some((r) => r.status === 'refused')) return;
    for (const r of recipients) {
      // A delivered recipient stays queued until its receipt says it was noticed or read.
      if (r.status === 'refused') {
        await mcp?.setRemoteStatus(messageId, formatAddress(r.handle, machineId), 'undelivered');
        deps.audit.record({
          kind: 'message.refused',
          peer: machineId,
          detail: { messageId, handle: r.handle, reason: r.reason ?? 'refused', direction: 'out' },
        });
      }
    }
    outbox.ack(machineId, messageId);
    persist();
  };

  const inbound = async (machineId: string, wire: WireMessage): Promise<void> => {
    const link = linkOf(machineId);
    const refuse = (reason: WireRecipientOutcome['reason']) =>
      wire.to.map((handle) => ({ handle, status: 'refused' as const, reason }));
    if (!link || !link.capabilities.messaging) {
      deps.send(machineId, {
        t: 'ack',
        messageId: wire.messageId,
        recipients: refuse('capability_off'),
      });
      deps.audit.record({
        kind: 'message.refused',
        peer: machineId,
        detail: { messageId: wire.messageId, reason: 'capability_off', direction: 'in' },
      });
      return;
    }
    if (
      !/^[a-z0-9-]+$/.test(wire.from) ||
      wire.to.some((h) => h.includes('@')) ||
      Buffer.byteLength(wire.body, 'utf8') > MAX_BODY_BYTES ||
      wire.subject.length > 200 ||
      wire.attachments.reduce((n, a) => n + Buffer.byteLength(a.data, 'base64'), 0) >
        MAX_MESSAGE_ATTACHMENT_BYTES
    ) {
      deps.send(machineId, {
        t: 'ack',
        messageId: wire.messageId,
        recipients: refuse('unknown_session'),
      });
      return;
    }
    const mcp = deps.mcp();
    // No ack without the store: the sender keeps the message queued and resends on the next up.
    if (mcp === null) return;
    if (mcp.hasMessage(wire.messageId)) {
      deps.send(machineId, {
        t: 'ack',
        messageId: wire.messageId,
        recipients: wire.to.map((handle) => ({ handle, status: 'delivered', reason: null })),
      });
      return;
    }
    const record: MessageRecord & { origin: string } = {
      messageId: wire.messageId,
      threadId: wire.threadId,
      from: formatAddress(wire.from, machineId),
      to: wire.to,
      subject: wire.subject,
      kind: wire.kind,
      priority: wire.priority,
      sentAt: wire.sentAt,
      body: wire.body,
      attachments: [],
      origin: machineId,
    };
    const blobs = wire.attachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      bytes: Buffer.from(a.data, 'base64'),
    }));
    // Plan decision 12: `you` there counts as the human here only while I let that machine drive.
    const framedAsHuman = wire.from === 'you' && link.capabilities.drive;
    const outcomes = await mcp.deliverInbound(record, blobs, framedAsHuman);
    deps.send(machineId, { t: 'ack', messageId: wire.messageId, recipients: outcomes });
    const delivered = outcomes.filter((o) => o.status === 'delivered').map((o) => o.handle);
    deps.audit.record({
      kind: delivered.length > 0 ? 'message.in' : 'message.refused',
      peer: machineId,
      principal: record.from,
      detail: { messageId: wire.messageId, to: delivered.join(','), direction: 'in' },
    });
  };

  return {
    start() {
      stopExpiry = deps.after(expire, EXPIRE_EVERY_MS);
      offLocalStatus =
        deps
          .mcp()
          ?.onLocalStatus((messageId, handle, status, origin) =>
            sendReceipt(origin, { t: 'receipt', messageId, handle, status }),
          ) ?? null;
    },
    stop() {
      stopExpiry?.();
      stopExpiry = null;
      offLocalStatus?.();
      offLocalStatus = null;
    },
    enqueue(msg, recipients) {
      // Non-transitive: a message that arrived over a link is never sent on to another machine.
      if (msg.origin !== undefined && msg.origin !== deps.machineId()) {
        return recipients.map((e) => ({
          address: e.address,
          status: 'refused',
          reason: 'capability_off',
        }));
      }
      const byMachine = new Map<string, RemoteEntry[]>();
      for (const e of recipients)
        byMachine.set(e.machineId, [...(byMachine.get(e.machineId) ?? []), e]);
      const outcomes: RemoteRecipientOutcome[] = [];
      for (const [machineId, entries] of byMachine) {
        const link = linkOf(machineId);
        const state = link?.state ?? 'revoked';
        const refused = (reason: RemoteRecipientOutcome['reason']) =>
          outcomes.push(
            ...entries.map((e) => ({ address: e.address, status: 'refused' as const, reason })),
          );
        if (state === 'revoked') refused('peer_revoked');
        else if (TERMINAL.includes(state)) refused('peer_incompatible');
        else if (link?.peerCapabilities && !link.peerCapabilities.messaging)
          refused('capability_off');
        else {
          outbox.enqueue({
            machineId,
            message: {
              messageId: msg.messageId,
              threadId: msg.threadId,
              from: msg.from,
              to: entries.map((e) => e.handle),
              subject: msg.subject,
              kind: msg.kind,
              priority: msg.priority,
              sentAt: msg.sentAt,
              body: msg.body,
              attachments: [],
            },
            addresses: entries.map((e) => e.address),
            enqueuedAt: deps.now(),
          });
          persist();
          const reason: RemoteRecipientOutcome['reason'] = live(state) ? null : 'peer_unreachable';
          outcomes.push(
            ...entries.map((e) => ({ address: e.address, status: 'queued' as const, reason })),
          );
          deps.audit.record({
            kind: 'message.out',
            peer: machineId,
            principal: msg.from,
            detail: { messageId: msg.messageId, to: entries.map((e) => e.handle).join(',') },
          });
          if (live(state)) flush(machineId);
        }
      }
      return outcomes;
    },
    linkUp(machineId) {
      flush(machineId);
      const held = heldReceipts.get(machineId) ?? [];
      heldReceipts.delete(machineId);
      for (const r of held) sendReceipt(machineId, r);
    },
    linkDown(machineId) {
      outbox.onDown(machineId);
    },
    revoked(machineId) {
      const gone = outbox.revoke(machineId);
      heldReceipts.delete(machineId);
      for (const e of gone)
        void markRemote(e, 'undelivered').catch((err: unknown) =>
          deps.log.error('revoke status failed', { message: String(err) }),
        );
      if (gone.length > 0) persist();
    },
    onFrame(machineId, frame) {
      const run =
        frame.t === 'msg'
          ? inbound(machineId, frame.message)
          : frame.t === 'ack'
            ? ack(machineId, frame.messageId, frame.recipients)
            : deps
                .mcp()
                ?.setRemoteStatus(
                  frame.messageId,
                  formatAddress(frame.handle, machineId),
                  frame.status,
                );
      void run?.catch((err: unknown) =>
        deps.log.error('message processing failed', { message: String(err) }),
      );
    },
  };
}
