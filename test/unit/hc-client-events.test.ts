import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameKind, INITIAL_STREAM_CREDIT } from '../../src/contracts/frames';
import type { HcNotification } from '../../src/contracts/hc';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';

let fake: FakeHc;
let client: NodeHcClient;
beforeEach(async () => {
  fake = new FakeHc();
  await fake.listen();
  client = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10 });
});
afterEach(async () => {
  client.close();
  await fake.close();
});
const barrier = () => client.call('server.status', {});
const title = (seq: number) =>
  ({
    method: 'event',
    params: { seq, type: 'title', terminal: 't1', data: { title: `title-${seq}` } },
  }) as const;

describe('hc event subscriptions', () => {
  it('ignores future notification methods that have no sequence', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    await barrier();
    fake.notify(fake.channels[0], { jsonrpc: '2.0', method: 'future_notification', params: {} });
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(1) });
    await expect(barrier()).resolves.toMatchObject({ live: 1 });
    expect(seen).toEqual([title(1)]);
  });

  it('turns malformed buffered event JSON into connection loss instead of an uncaught exception', async () => {
    const states: string[] = [];
    client.onConnection((state) => states.push(state));
    fake.afterReply = (method, result) => {
      if (
        method === 'events.subscribe' &&
        result &&
        typeof result === 'object' &&
        'channel' in result &&
        typeof result.channel === 'number'
      )
        fake.send(result.channel, Buffer.from('{invalid\n'));
    };
    await client.subscribe({}, () => {});
    await expect.poll(() => states.includes('lost')).toBe(true);
  });

  it('exposes the snapshot before ordered notifications and ignores snapshot-era events', async () => {
    const seen: (string | HcNotification)[] = [];
    const sub = await client.subscribe({}, (n) => seen.push(n));
    seen.push(sub.snapshot[0].address);
    const channel = fake.channels[0];
    for (const seq of [0, 1, 2]) fake.notify(channel, { jsonrpc: '2.0', ...title(seq) });
    await barrier();
    expect(seen).toEqual(['t1', title(1), title(2)]);
  });

  it('hands the snapshot to the caller before a notification sent immediately after the reply', async () => {
    const seen: string[] = [];
    fake.afterReply = (method, result) => {
      if (
        method === 'events.subscribe' &&
        result &&
        typeof result === 'object' &&
        'channel' in result &&
        typeof result.channel === 'number'
      ) {
        fake.notify(result.channel, { jsonrpc: '2.0', ...title(1) });
      }
    };
    const sub = await client.subscribe({}, () => seen.push('event'));
    seen.push(sub.snapshot[0].address);
    await expect.poll(() => seen).toEqual(['t1', 'event']);
  });

  it('reassembles JSON lines split across event DATA frames', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...title(1) })}\n`);
    fake.send(fake.channels[0], bytes.subarray(0, 15));
    await barrier();
    expect(seen).toEqual([]);
    fake.send(fake.channels[0], bytes.subarray(15));
    await expect.poll(() => seen).toEqual([title(1)]);
  });

  it('accepts event messages framed without a trailing newline, whole or split', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    const channel = fake.channels[0];
    fake.send(channel, Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...title(1) })));
    await expect.poll(() => seen).toEqual([title(1)]);
    const second = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...title(2) }));
    fake.send(channel, second.subarray(0, 20));
    await barrier();
    expect(seen).toEqual([title(1)]);
    fake.send(channel, second.subarray(20));
    await expect.poll(() => seen).toEqual([title(1), title(2)]);
  });

  it('surfaces a sequence gap with an atomic fresh missed snapshot before later events', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    fake.seq = 4;
    fake.terminals[0].title = 'latest';
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(4) });
    await expect
      .poll(() => seen[0])
      .toMatchObject({
        method: 'missed',
        params: { seq: 4, terminals: [{ address: 't1', title: 'latest' }] },
      });
    expect(fake.calls.filter((call) => call.method === 'events.subscribe')).toHaveLength(2);
    fake.notify(fake.channels[1], { jsonrpc: '2.0', ...title(5) });
    await expect.poll(() => seen[1]).toEqual(title(5));
  });

  it('accepts wire missed snapshots, drops older events, and forwards heartbeats', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    const channel = fake.channels[0];
    const missed = { method: 'missed', params: { seq: 10, terminals: [] } } as const;
    const heartbeat = { method: 'heartbeat', params: { seq: 11 } } as const;
    fake.notify(channel, { jsonrpc: '2.0', ...missed });
    fake.notify(channel, { jsonrpc: '2.0', ...title(9) });
    fake.notify(channel, { jsonrpc: '2.0', ...title(11) });
    fake.notify(channel, { jsonrpc: '2.0', ...heartbeat });
    await barrier();
    expect(seen).toEqual([missed, title(11), heartbeat]);
  });

  it('preserves unknown event kinds as unknown without ending the subscription', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    const raw = { seq: 1, type: 'future', extra: true };
    fake.notify(fake.channels[0], { jsonrpc: '2.0', method: 'event', params: raw });
    await expect
      .poll(() => seen)
      .toEqual([{ method: 'event', params: { seq: 1, type: 'unknown', raw } }]);
  });

  it('returns event-channel credit after dispatch so notifications keep flowing past a window', async () => {
    let count = 0;
    await client.subscribe({}, () => {
      count++;
    });
    const lines = `${Array.from({ length: 4000 }, (_, index) =>
      JSON.stringify({ jsonrpc: '2.0', ...title(index + 1) }),
    ).join('\n')}\n`;
    expect(Buffer.byteLength(lines)).toBeGreaterThan(INITIAL_STREAM_CREDIT);
    fake.send(fake.channels[0], Buffer.from(lines));
    await expect.poll(() => count, { timeout: 3000 }).toBe(4000);
    expect(
      fake.frames.some(
        (frame) => frame.kind === FrameKind.Credit && frame.channel === fake.channels[0],
      ),
    ).toBe(true);
  });

  it('closes the event channel and stops callbacks', async () => {
    const seen: HcNotification[] = [];
    const sub = await client.subscribe({}, (n) => seen.push(n));
    const channel = fake.channels[0];
    sub.close();
    await barrier();
    expect(
      fake.frames.some((frame) => frame.channel === channel && frame.kind === FrameKind.Close),
    ).toBe(true);
    fake.sendFrame({
      channel,
      kind: FrameKind.Data,
      payload: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...title(1) })}\n`),
    });
    await barrier();
    expect(seen).toEqual([]);
  });
});
