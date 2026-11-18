import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import {
  createMessaging,
  type MessagingLink,
  RECEIPT_BASE_PER_MIN,
} from '../../server/network/messaging';
import type { McpNetworkPort, RemoteEntry } from '../../src/conduit-mcp/remote-routing';
import type { MessageRecord } from '../../src/conduit-mcp/types';
import {
  LINK_FRAME_MAX_BYTES,
  type LinkFrame,
  type WireMessage,
} from '../../src/contracts/link-protocol';
import { encodeFrame } from '../../src/network/frame-codec';
import { type OutboxEntry, serializeOutboxFile } from '../../src/network/outbox';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const machine = 'm-12345678';
const wire: WireMessage = {
  messageId: 'm_abcdefghijklmnop',
  threadId: 't_abcdefghijklmnop',
  from: 'agent-1',
  to: ['agent-2'],
  subject: 'hi',
  kind: 'inform',
  priority: 'normal',
  sentAt: '2026-01-01T00:00:00Z',
  body: 'hello',
  attachments: [],
};
function setup(seed: OutboxEntry[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'messaging-'));
  dirs.push(dir);
  // Seeded before the service loads, so a test can start with a full outbox without N writes.
  if (seed.length > 0) writeFileSync(join(dir, 'outbox.json'), serializeOutboxFile(seed));
  const caps = { messaging: true, monitor: true, drive: false, orchestrate: false };
  const link: MessagingLink = {
    machineId: machine,
    state: 'down',
    capabilities: caps,
    peerCapabilities: caps,
  };
  const frames: LinkFrame[] = [];
  const audit: AuditEvent[] = [];
  let now = 0;
  let timer = () => {};
  let listener: Parameters<McpNetworkPort['onLocalStatus']>[0] = () => {};
  const mcp: McpNetworkPort = {
    localDirectory: () => [],
    hasMessage: vi.fn(() => false),
    readBlob: vi.fn(async () => undefined),
    threadExportedTo: vi.fn(() => false),
    wireThreadFor: vi.fn((threadId: string) => threadId),
    deliverInbound: vi.fn(async (msg: MessageRecord) =>
      msg.to.map((handle) => ({ handle, status: 'delivered' as const, reason: null })),
    ),
    setRemoteStatus: vi.fn(async () => {}),
    onLocalStatus: (fn) => {
      listener = fn;
      return () => {};
    },
    youUnread: () => 0,
    ownerPresence: () => 'here',
    requestsSummary: () => [],
    callAsRemote: () => Promise.reject(new Error('not used by this test')),
    remoteRequests: () => ({ apply: () => false, setLinkState: () => {} }),
    mirrorOf: () => [],
    applyRemoteAnswer: () => ({ ok: false, reason: 'not_found', message: 'not used by this test' }),
    requestsHasEnded: () => false,
    onRequestsMirrorChange: () => () => {},
    policyDoc: () => ({ rev: 0, doc: { profiles: [], assignments: [] }, grants: [] }),
    onPolicyDocChange: () => () => {},
    applyRemotePolicy: () => ({
      ok: false,
      code: 'policy_unavailable',
      message: 'not used by this test',
    }),
    revokeRemoteGrant: () => ({ ok: false, code: 'not_found', message: 'not used by this test' }),
    remotePolicySink: () => ({
      apply: () => undefined,
      setLinkState: () => undefined,
      connectionReplaced: () => undefined,
    }),
  };
  const svc = createMessaging({
    file: join(dir, 'outbox.json'),
    machineId: () => 'm-87654321',
    links: () => [link],
    send: (_id, frame) => {
      frames.push(frame);
      return true;
    },
    mcp: () => mcp,
    audit: { record: (e) => audit.push(e) },
    log: { warn: () => {}, error: () => {} },
    now: () => now,
    after: (fn) => {
      timer = fn;
      return () => {};
    },
  });
  svc.start();
  const msg: MessageRecord = { ...wire, attachments: [] };
  const recipient = {
    handle: 'agent-2',
    address: `agent-2@${machine}`,
    machineId: machine,
  } as RemoteEntry;
  return {
    svc,
    dir,
    link,
    frames,
    audit,
    mcp,
    msg,
    recipient,
    tick: (t: number) => {
      now = t;
      timer();
    },
    receipt: () => listener('m_abcdefghijklmnop', 'agent-2', 'read', machine),
  };
}

it('flushes queued messages on link up and handles refused acknowledgements', async () => {
  const h = setup();
  expect(h.svc.enqueue(h.msg, [h.recipient])[0].reason).toBe('peer_unreachable');
  expect(h.frames).toHaveLength(0);
  h.link.state = 'up';
  h.svc.linkUp(machine);
  expect(h.frames[0]).toMatchObject({ t: 'msg', message: { messageId: 'm_abcdefghijklmnop' } });
  h.svc.onFrame(machine, {
    t: 'ack',
    messageId: 'm_abcdefghijklmnop',
    recipients: [{ handle: 'agent-2', status: 'refused', reason: 'unknown_session' }],
  });
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith(
      'm_abcdefghijklmnop',
      `agent-2@${machine}`,
      'undelivered',
    ),
  );
});
it('expires and revokes queued messages', async () => {
  const h = setup();
  h.svc.enqueue(h.msg, [h.recipient]);
  h.tick(24 * 60 * 60 * 1000);
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith(
      'm_abcdefghijklmnop',
      `agent-2@${machine}`,
      'expired',
    ),
  );
  h.svc.enqueue({ ...h.msg, messageId: 'm_qrstuvwxyzabcdef' }, [h.recipient]);
  h.svc.revoked(machine);
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith(
      'm_qrstuvwxyzabcdef',
      `agent-2@${machine}`,
      'undelivered',
    ),
  );
});
it('refuses disabled capability and deduplicates', () => {
  const h = setup();
  h.link.capabilities.messaging = false;
  h.svc.onFrame(machine, { t: 'msg', message: wire });
  expect(h.frames[0]).toMatchObject({ recipients: [{ reason: 'capability_off' }] });
  h.link.capabilities.messaging = true;
  vi.mocked(h.mcp.hasMessage).mockReturnValue(true);
  h.svc.onFrame(machine, { t: 'msg', message: wire });
  expect(h.frames[1]).toMatchObject({ recipients: [{ status: 'delivered' }] });
  expect(h.mcp.deliverInbound).not.toHaveBeenCalled();
});
it('refuses transitive sends and holds receipts while down', () => {
  const h = setup();
  expect(h.svc.enqueue({ ...h.msg, origin: machine }, [h.recipient])[0].status).toBe('refused');
  h.receipt();
  expect(h.frames).toHaveLength(0);
  h.link.state = 'up';
  h.svc.linkUp(machine);
  expect(h.frames[0]).toMatchObject({ t: 'receipt', status: 'read' });
});
it.each([
  { from: 'agent\nforged' },
  { to: ['agent-2@m-12345678'] },
  { body: 'x'.repeat(32769) },
  { subject: 'x'.repeat(201) },
  {
    attachments: [
      {
        name: 'x',
        mime: 'text/plain',
        data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
      },
    ],
  },
  { messageId: 'm_short' },
])('refuses malformed or oversized inbound messages without acknowledging them', (patch) => {
  const h = setup();
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, ...patch } });
  expect(h.mcp.deliverInbound).not.toHaveBeenCalled();
  // CON-27 R2a: an ack for a message that fails validation would amplify, so the sender's outbox expires it instead.
  expect(ackFrames(h.frames)).toEqual([]);
  expect(h.audit.filter((e) => e.kind === 'message.refused')).toHaveLength(1);
});
it('does not acknowledge a failed durable append', async () => {
  const h = setup();
  vi.mocked(h.mcp.deliverInbound).mockRejectedValue(new Error('disk'));
  h.svc.onFrame(machine, { t: 'msg', message: wire });
  await vi.waitFor(() => expect(h.mcp.deliverInbound).toHaveBeenCalled());
  expect(h.frames).toHaveLength(0);
});

it('keeps an acknowledgement pending when updating status fails', async () => {
  const h = setup();
  h.svc.enqueue(h.msg, [h.recipient]);
  h.link.state = 'up';
  h.svc.linkUp(machine);
  vi.mocked(h.mcp.setRemoteStatus).mockRejectedValueOnce(new Error('disk'));
  h.svc.onFrame(machine, {
    t: 'ack',
    messageId: 'm_abcdefghijklmnop',
    recipients: [{ handle: 'agent-2', status: 'refused', reason: 'unknown_session' }],
  });
  await vi.waitFor(() => expect(h.mcp.setRemoteStatus).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.svc.linkDown(machine);
  h.svc.linkUp(machine);
  await vi.waitFor(() => expect(h.frames.filter((frame) => frame.t === 'msg')).toHaveLength(2));
});

it('persists blob references and delivers the exact attachment bytes', async () => {
  const sender = setup();
  const receiver = setup();
  const bytes = Buffer.from('attachment payload\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  vi.mocked(sender.mcp.readBlob).mockResolvedValue(bytes);
  const message = {
    ...sender.msg,
    attachments: [
      { attachmentId: 'a1', name: 'note.txt', mime: 'text/plain', bytes: bytes.length, sha256 },
    ],
  };
  sender.svc.enqueue(message, [sender.recipient]);
  const persisted = readFileSync(join(sender.dir, 'outbox.json'), 'utf8');
  expect(persisted).toContain(sha256);
  expect(persisted).not.toContain(bytes.toString('base64'));
  expect(JSON.parse(persisted).entries[0].attachmentRefs).toEqual([
    { sha256, name: 'note.txt', mime: 'text/plain' },
  ]);
  sender.link.state = 'up';
  sender.svc.linkUp(machine);
  await vi.waitFor(() => expect(sender.frames.some((f) => f.t === 'msg')).toBe(true));
  const frame = sender.frames.find((f) => f.t === 'msg');
  if (!frame || frame.t !== 'msg') throw new Error('message not sent');
  receiver.svc.onFrame(machine, frame);
  await vi.waitFor(() => expect(receiver.mcp.deliverInbound).toHaveBeenCalled());
  expect(vi.mocked(receiver.mcp.deliverInbound).mock.calls[0][1]).toEqual([
    { name: 'note.txt', mime: 'text/plain', bytes },
  ]);
});

it('marks the recipient undelivered and removes the outbox entry if a blob is missing', async () => {
  const h = setup();
  const sha256 = 'a'.repeat(64);
  h.svc.enqueue(
    {
      ...h.msg,
      attachments: [{ attachmentId: 'a1', name: 'gone', mime: 'text/plain', bytes: 1, sha256 }],
    },
    [h.recipient],
  );
  h.link.state = 'up';
  h.svc.linkUp(machine);
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith(
      'm_abcdefghijklmnop',
      `agent-2@${machine}`,
      'undelivered',
    ),
  );
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(join(h.dir, 'outbox.json'), 'utf8')).entries).toEqual([]),
  );
  expect(h.frames.filter((f) => f.t === 'msg')).toEqual([]);
});

it('fits a 10 MiB attachment and maximum message body in one wire frame', async () => {
  const h = setup();
  const bytes = Buffer.alloc(10 * 1024 * 1024, 42);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  vi.mocked(h.mcp.readBlob).mockResolvedValue(bytes);
  h.svc.enqueue(
    {
      ...h.msg,
      body: 'x'.repeat(32 * 1024),
      attachments: [
        { attachmentId: 'a1', name: 'large.txt', mime: 'text/plain', bytes: bytes.length, sha256 },
      ],
    },
    [h.recipient],
  );
  h.link.state = 'up';
  h.svc.linkUp(machine);
  await vi.waitFor(() => expect(h.frames.some((f) => f.t === 'msg')).toBe(true));
  const frame = h.frames.find((f) => f.t === 'msg');
  if (!frame) throw new Error('message not sent');
  expect(encodeFrame(frame).length - 4).toBeLessThanOrEqual(LINK_FRAME_MAX_BYTES);
});

it('does not send a blob read after a link is revoked', async () => {
  const h = setup();
  let finish: (bytes: Uint8Array) => void = () => {};
  vi.mocked(h.mcp.readBlob).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.svc.enqueue(
    {
      ...h.msg,
      attachments: [
        { attachmentId: 'a1', name: 'x', mime: 'text/plain', bytes: 1, sha256: 'b'.repeat(64) },
      ],
    },
    [h.recipient],
  );
  h.link.state = 'up';
  h.svc.linkUp(machine);
  await vi.waitFor(() => expect(h.mcp.readBlob).toHaveBeenCalled());
  h.svc.revoked(machine);
  finish(Buffer.from('x'));
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith(
      'm_abcdefghijklmnop',
      `agent-2@${machine}`,
      'undelivered',
    ),
  );
  expect(h.frames.filter((f) => f.t === 'msg')).toEqual([]);
});

it('preserves FIFO when a link drops while the first blob is loading', async () => {
  const h = setup();
  let finish: (bytes: Uint8Array) => void = () => {};
  vi.mocked(h.mcp.readBlob)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(Buffer.from('blob'));
  h.svc.enqueue(
    {
      ...h.msg,
      attachments: [
        { attachmentId: 'a1', name: 'x', mime: 'text/plain', bytes: 4, sha256: 'c'.repeat(64) },
      ],
    },
    [h.recipient],
  );
  h.svc.enqueue({ ...h.msg, messageId: 'm_234567abcdefghij' }, [h.recipient]);
  h.link.state = 'up';
  h.svc.linkUp(machine);
  await vi.waitFor(() => expect(h.mcp.readBlob).toHaveBeenCalledTimes(1));
  expect(h.frames.filter((f) => f.t === 'msg')).toEqual([]);
  h.link.state = 'down';
  h.svc.linkDown(machine);
  h.link.state = 'up';
  h.svc.linkUp(machine);
  finish(Buffer.from('blob'));
  await vi.waitFor(() => expect(h.frames.filter((f) => f.t === 'msg')).toHaveLength(2));
  expect(h.frames.flatMap((f) => (f.t === 'msg' ? [f.message.messageId] : []))).toEqual([
    'm_abcdefghijklmnop',
    'm_234567abcdefghij',
  ]);
});

const SECOND_ID = 'm_234567abcdefghij';
const msgIds = (frames: LinkFrame[]) =>
  frames.flatMap((f) => (f.t === 'msg' ? [f.message.messageId] : []));

it('a reconnect resends what the old connection already took, in order', async () => {
  const h = setup();
  h.link.state = 'up';
  h.svc.enqueue(h.msg, [h.recipient]);
  await vi.waitFor(() => expect(h.frames).toHaveLength(1));
  h.svc.enqueue({ ...h.msg, messageId: SECOND_ID }, [h.recipient]);
  await vi.waitFor(() => expect(h.frames).toHaveLength(2));
  const auditBefore = h.audit.length;
  h.svc.reconnected(machine);
  await vi.waitFor(() => expect(h.frames).toHaveLength(4));
  expect(msgIds(h.frames)).toEqual([
    'm_abcdefghijklmnop',
    SECOND_ID,
    'm_abcdefghijklmnop',
    SECOND_ID,
  ]);
  expect(h.audit).toHaveLength(auditBefore);
  expect(h.mcp.setRemoteStatus).not.toHaveBeenCalled();
});

it('a reconnect during a flush still loading a blob resends the sent entry ahead of the newer one', async () => {
  const h = setup();
  let finish: (bytes: Uint8Array) => void = () => {};
  vi.mocked(h.mcp.readBlob)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(Buffer.from('blob'));
  h.link.state = 'up';
  h.svc.enqueue(h.msg, [h.recipient]);
  await vi.waitFor(() => expect(h.frames).toHaveLength(1));
  h.svc.enqueue(
    {
      ...h.msg,
      messageId: SECOND_ID,
      attachments: [
        { attachmentId: 'a1', name: 'x', mime: 'text/plain', bytes: 4, sha256: 'c'.repeat(64) },
      ],
    },
    [h.recipient],
  );
  await vi.waitFor(() => expect(h.mcp.readBlob).toHaveBeenCalledTimes(1));
  h.svc.reconnected(machine);
  finish(Buffer.from('blob'));
  await vi.waitFor(() => expect(h.frames).toHaveLength(3));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(msgIds(h.frames)).toEqual(['m_abcdefghijklmnop', 'm_abcdefghijklmnop', SECOND_ID]);
});

// A distinct valid id for each i: 'm_' / 't_' plus 16 base32 chars.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ident = (prefix: 'm' | 't', i: number): string => {
  let s = '';
  for (let n = i; s.length < 16; n = Math.floor(n / 32)) s += B32[n % 32];
  return `${prefix}_${s}`;
};
const frameN = (i: number, over: Partial<WireMessage> = {}): Extract<LinkFrame, { t: 'msg' }> => ({
  t: 'msg',
  message: { ...wire, messageId: ident('m', i), threadId: ident('t', i), ...over },
});
const ackFrames = (frames: LinkFrame[]) =>
  frames.filter((f): f is Extract<LinkFrame, { t: 'ack' }> => f.t === 'ack');

// CON-27 review, minor 6: a full outbox refuses the send to that machine, and says so.
it('refuses a send that finds the outbox full, as outbox_full, and stores nothing for it', () => {
  const full: OutboxEntry[] = Array.from({ length: 1000 }, (_, i) => ({
    machineId: machine,
    message: { ...wire, messageId: ident('m', i), threadId: ident('t', i) },
    addresses: [`agent-2@${machine}`],
    enqueuedAt: 0,
    state: 'queued',
  }));
  const h = setup(full);
  expect(h.svc.enqueue(h.msg, [h.recipient])).toEqual([
    { address: h.recipient.address, status: 'refused', reason: 'outbox_full' },
  ]);
  expect(JSON.parse(readFileSync(join(h.dir, 'outbox.json'), 'utf8')).entries).toHaveLength(1000);
});

// CON-27 security review M2: a peer cannot fill the disk through one link.
it('refuses the 121st message frame from one link in a minute, and accepts again a minute later', () => {
  const h = setup();
  h.link.state = 'up';
  for (let i = 0; i < 120; i++) h.svc.onFrame(machine, frameN(i));
  expect(vi.mocked(h.mcp.deliverInbound)).toHaveBeenCalledTimes(120);
  h.svc.onFrame(machine, frameN(120));
  expect(vi.mocked(h.mcp.deliverInbound)).toHaveBeenCalledTimes(120);
  expect(ackFrames(h.frames).at(-1)?.recipients).toEqual([
    { handle: 'agent-2', status: 'refused', reason: 'rate_limited' },
  ]);
  h.tick(60_000);
  h.svc.onFrame(machine, frameN(121));
  expect(vi.mocked(h.mcp.deliverInbound)).toHaveBeenCalledTimes(121);
});

it('refuses a message to more than 10 recipients and stores nothing', () => {
  const h = setup();
  const to = Array.from({ length: 11 }, (_, i) => `agent-${i}`);
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, to } });
  expect(vi.mocked(h.mcp.deliverInbound)).not.toHaveBeenCalled();
  expect(ackFrames(h.frames)).toEqual([]);
});

// CON-27 R2a: a 1,000-recipient message would make the ack echo 1,000 handles back to the peer.
it('sends no ack for a 1,000-recipient message, on any refusal path', () => {
  const to = Array.from({ length: 1000 }, (_, i) => `agent-${i}`);
  const h = setup();
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, to } });
  expect(ackFrames(h.frames)).toEqual([]);
  h.link.capabilities.messaging = false;
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, to } });
  expect(ackFrames(h.frames)).toEqual([]);
});

it('sends no ack for a malformed message id, even when capability is off', () => {
  const h = setup();
  h.link.capabilities.messaging = false;
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, messageId: 'not-an-id' } });
  expect(ackFrames(h.frames)).toEqual([]);
});

// CON-27 R2a: a capability_off ack lists at most MAX_RECIPIENTS handles, and only for a sound message.
it('caps a capability_off ack at 10 recipients', () => {
  const h = setup();
  h.link.capabilities.messaging = false;
  const to = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, to } });
  expect(ackFrames(h.frames).at(-1)?.recipients).toHaveLength(10);
});

// CON-27 R2a: the rate_limited ack is bounded the same way as the capability_off one.
it('bounds the rate_limited ack the same way: 10 recipients at most, none for an oversized message', () => {
  const h = setup();
  h.link.state = 'up';
  for (let i = 0; i < 120; i++) h.svc.onFrame(machine, frameN(i));
  const to = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
  h.svc.onFrame(machine, frameN(120, { to }));
  expect(ackFrames(h.frames).at(-1)?.recipients).toHaveLength(10);
  const big = Array.from({ length: 1000 }, (_, i) => `agent-${i}`);
  const before = ackFrames(h.frames).length;
  h.svc.onFrame(machine, frameN(121, { to: big }));
  expect(ackFrames(h.frames)).toHaveLength(before);
});

it('acts on each recipient the outbox entry was addressed to, once: an ack with 1,000 recipients writes one status', async () => {
  const h = setup();
  h.svc.enqueue(h.msg, [h.recipient]);
  const recipients = Array.from({ length: 1000 }, (_, i) => ({
    handle: i === 0 ? 'agent-2' : `stranger-${i}`,
    status: 'refused' as const,
    reason: 'unknown_session' as const,
  }));
  h.svc.onFrame(machine, { t: 'ack', messageId: 'm_abcdefghijklmnop', recipients });
  await vi.waitFor(() => expect(h.mcp.setRemoteStatus).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(vi.mocked(h.mcp.setRemoteStatus)).toHaveBeenCalledTimes(1);
  expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith(
    'm_abcdefghijklmnop',
    `agent-2@${machine}`,
    'undelivered',
  );
});

it('ignores a repeated handle in an ack after the first', async () => {
  const h = setup();
  h.svc.enqueue(h.msg, [h.recipient]);
  const refused = { handle: 'agent-2', status: 'refused' as const, reason: null };
  h.svc.onFrame(machine, {
    t: 'ack',
    messageId: 'm_abcdefghijklmnop',
    recipients: [refused, refused, refused],
  });
  await vi.waitFor(() => expect(h.mcp.setRemoteStatus).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(vi.mocked(h.mcp.setRemoteStatus)).toHaveBeenCalledTimes(1);
});

it('audits a refused inbound message once per link per minute', () => {
  const h = setup();
  h.link.capabilities.messaging = false;
  for (let i = 0; i < 5; i++) h.svc.onFrame(machine, frameN(i));
  expect(h.audit.filter((e) => e.kind === 'message.refused')).toHaveLength(1);
  h.tick(59_999);
  h.svc.onFrame(machine, frameN(5));
  expect(h.audit.filter((e) => e.kind === 'message.refused')).toHaveLength(1);
  h.tick(60_000);
  h.svc.onFrame(machine, frameN(6));
  expect(h.audit.filter((e) => e.kind === 'message.refused')).toHaveLength(2);
});

// CON-27 R2c: receipts draw on the same per-link inbound budget as messages, and count only while
// messaging is on for that link here.
const receiptFrame = (i: number): Extract<LinkFrame, { t: 'receipt' }> => ({
  t: 'receipt',
  messageId: `m_${'a'.repeat(15)}${'abcdefghijklmnopqrstuvwxyz234567'[i % 32]}`,
  handle: 'agent-2',
  status: 'noticed',
});
it('drops a receipt past the link’s receipt budget silently, and one while messaging is off here', () => {
  const h = setup();
  h.link.state = 'up';
  for (let i = 0; i < RECEIPT_BASE_PER_MIN; i++) h.svc.onFrame(machine, receiptFrame(i));
  vi.mocked(h.mcp.setRemoteStatus).mockClear();
  const receipt = {
    t: 'receipt' as const,
    messageId: 'm_abcdefghijklmnop',
    handle: 'agent-2',
    status: 'read' as const,
  };
  h.svc.onFrame(machine, receipt);
  expect(h.mcp.setRemoteStatus).not.toHaveBeenCalled();
  h.tick(60_000);
  h.svc.onFrame(machine, receipt);
  expect(h.mcp.setRemoteStatus).toHaveBeenCalledTimes(1);
  h.link.capabilities.messaging = false;
  h.svc.onFrame(machine, { ...receipt, status: 'noticed' });
  expect(h.mcp.setRemoteStatus).toHaveBeenCalledTimes(1);
});

// CON-27 R3: an attachment name or mime that is not plain text gets no ack, like any malformed message.
it.each([
  { name: 'x'.repeat(201), mime: 'text/plain' },
  { name: 'bad\nname', mime: 'text/plain' },
  { name: '   ', mime: 'text/plain' },
  { name: 'note.txt', mime: 'text/plain; charset=utf-8' },
  { name: 'note.txt', mime: `a/${'b'.repeat(99)}` },
  { name: 'note.txt', mime: 'text' },
])('refuses an inbound attachment with a bad name or mime, unacknowledged: %j', (att) => {
  const h = setup();
  h.svc.onFrame(machine, {
    t: 'msg',
    message: { ...wire, attachments: [{ ...att, data: '' }] },
  });
  expect(vi.mocked(h.mcp.deliverInbound)).not.toHaveBeenCalled();
  expect(ackFrames(h.frames)).toEqual([]);
});

it('accepts a 200-character attachment name and a mime with a capital letter', () => {
  const h = setup();
  h.svc.onFrame(machine, {
    t: 'msg',
    message: {
      ...wire,
      attachments: [{ name: 'x'.repeat(200), mime: 'Text/Plain', data: '' }],
    },
  });
  expect(vi.mocked(h.mcp.deliverInbound)).toHaveBeenCalledTimes(1);
});

// CON-27 third pass N1: receipts have their own per-link budget, sized from what we sent that
// peer, so a busy conversation's receipts never rate-limit real messages or get dropped.
it('receipts never use up the message budget', async () => {
  const h = setup();
  h.link.state = 'up';
  for (let i = 0; i < 120; i++) h.svc.onFrame(machine, receiptFrame(i));
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, messageId: 'm_zzzzzzzzzzzzzzzz' } });
  await vi.waitFor(() => expect(h.mcp.deliverInbound).toHaveBeenCalledTimes(1));
});
it('receipts beyond their own budget are dropped', async () => {
  const h = setup();
  h.link.state = 'up';
  for (let i = 0; i < RECEIPT_BASE_PER_MIN + 5; i++) h.svc.onFrame(machine, receiptFrame(i));
  await vi.waitFor(() => expect(h.mcp.setRemoteStatus).toHaveBeenCalledTimes(RECEIPT_BASE_PER_MIN));
});
it('the receipt budget grows with the messages sent to that peer', async () => {
  const h = setup();
  for (let i = 0; i < 50; i++)
    h.svc.enqueue(
      { ...h.msg, messageId: `m_${'b'.repeat(14)}${i.toString(32).padStart(2, 'a')}` },
      [h.recipient],
    );
  h.link.state = 'up';
  const budget = RECEIPT_BASE_PER_MIN + 2 * 50;
  for (let i = 0; i < budget + 5; i++) h.svc.onFrame(machine, receiptFrame(i));
  await vi.waitFor(() => expect(h.mcp.setRemoteStatus).toHaveBeenCalledTimes(budget));
});
