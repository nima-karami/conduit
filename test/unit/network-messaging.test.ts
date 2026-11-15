import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createMessaging, type MessagingLink } from '../../server/network/messaging';
import type { McpNetworkPort, RemoteEntry } from '../../src/conduit-mcp/remote-routing';
import type { MessageRecord } from '../../src/conduit-mcp/types';
import {
  LINK_FRAME_MAX_BYTES,
  type LinkFrame,
  type WireMessage,
} from '../../src/contracts/link-protocol';
import { encodeFrame } from '../../src/network/frame-codec';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const machine = 'm-12345678';
const wire: WireMessage = {
  messageId: 'id',
  threadId: 'thread',
  from: 'agent-1',
  to: ['agent-2'],
  subject: 'hi',
  kind: 'inform',
  priority: 'normal',
  sentAt: '2026-01-01T00:00:00Z',
  body: 'hello',
  attachments: [],
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'messaging-'));
  dirs.push(dir);
  const caps = { messaging: true, monitor: true, drive: false, orchestrate: false };
  const link: MessagingLink = {
    machineId: machine,
    state: 'down',
    capabilities: caps,
    peerCapabilities: caps,
  };
  const frames: LinkFrame[] = [];
  let now = 0;
  let timer = () => {};
  let listener: Parameters<McpNetworkPort['onLocalStatus']>[0] = () => {};
  const mcp: McpNetworkPort = {
    localDirectory: () => [],
    hasMessage: vi.fn(() => false),
    readBlob: vi.fn(async () => undefined),
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
    audit: { record: () => {} },
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
    mcp,
    msg,
    recipient,
    tick: (t: number) => {
      now = t;
      timer();
    },
    receipt: () => listener('id', 'agent-2', 'read', machine),
  };
}

it('flushes queued messages on link up and handles refused acknowledgements', async () => {
  const h = setup();
  expect(h.svc.enqueue(h.msg, [h.recipient])[0].reason).toBe('peer_unreachable');
  expect(h.frames).toHaveLength(0);
  h.link.state = 'up';
  h.svc.linkUp(machine);
  expect(h.frames[0]).toMatchObject({ t: 'msg', message: { messageId: 'id' } });
  h.svc.onFrame(machine, {
    t: 'ack',
    messageId: 'id',
    recipients: [{ handle: 'agent-2', status: 'refused', reason: 'unknown_session' }],
  });
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith('id', `agent-2@${machine}`, 'undelivered'),
  );
});
it('expires and revokes queued messages', async () => {
  const h = setup();
  h.svc.enqueue(h.msg, [h.recipient]);
  h.tick(24 * 60 * 60 * 1000);
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith('id', `agent-2@${machine}`, 'expired'),
  );
  h.svc.enqueue({ ...h.msg, messageId: 'other' }, [h.recipient]);
  h.svc.revoked(machine);
  await vi.waitFor(() =>
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith(
      'other',
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
])('refuses malformed or oversized inbound messages', (patch) => {
  const h = setup();
  h.svc.onFrame(machine, { t: 'msg', message: { ...wire, ...patch } });
  expect(h.mcp.deliverInbound).not.toHaveBeenCalled();
  expect(h.frames[0]).toMatchObject({ t: 'ack', recipients: [{ status: 'refused' }] });
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
    messageId: 'id',
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
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith('id', `agent-2@${machine}`, 'undelivered'),
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
    expect(h.mcp.setRemoteStatus).toHaveBeenCalledWith('id', `agent-2@${machine}`, 'undelivered'),
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
  h.svc.enqueue({ ...h.msg, messageId: 'second' }, [h.recipient]);
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
    'id',
    'second',
  ]);
});
