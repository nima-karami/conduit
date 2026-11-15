import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createMessaging, type MessagingLink } from '../../server/network/messaging';
import type { McpNetworkPort, RemoteEntry } from '../../src/conduit-mcp/remote-routing';
import type { MessageRecord } from '../../src/conduit-mcp/types';
import type { LinkFrame, WireMessage } from '../../src/contracts/link-protocol';

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
        data: Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64'),
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
  expect(h.frames.filter((frame) => frame.t === 'msg')).toHaveLength(2);
});
