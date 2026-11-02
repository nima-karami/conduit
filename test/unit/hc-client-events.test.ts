import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('decodes a multi-byte UTF-8 character split across two DATA frames inside an event string', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    const bytes = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { seq: 1, type: 'title', terminal: 't1', data: { title: 'café!' } },
      }),
    );
    const split = bytes.indexOf(0xc3) + 1;
    fake.send(fake.channels[0], bytes.subarray(0, split));
    await barrier();
    expect(seen).toEqual([]);
    fake.send(fake.channels[0], bytes.subarray(split));
    await expect
      .poll(() => seen)
      .toEqual([
        {
          method: 'event',
          params: { seq: 1, type: 'title', terminal: 't1', data: { title: 'café!' } },
        },
      ]);
  });

  it('ignores a wire-sent ended notification; it is client-made only', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    fake.notify(fake.channels[0], {
      jsonrpc: '2.0',
      method: 'ended',
      params: { seq: 1, reason: 'closed' },
    });
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(2) });
    await barrier();
    expect(seen).toEqual([title(2)]);
  });

  it('ends only the subscription with ended on malformed event JSON, keeping the connection', async () => {
    const states: string[] = [];
    client.onConnection((state) => states.push(state));
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    const channel = fake.channels[0];
    fake.send(channel, Buffer.from('{"jsonrpc":"2.0","method":"event","params":}\n'));
    await expect.poll(() => seen).toEqual([{ method: 'ended', params: { reason: 'malformed' } }]);
    await expect
      .poll(() => fake.frames.some((f) => f.channel === channel && f.kind === FrameKind.Close))
      .toBe(true);
    fake.sendFrame({
      channel,
      kind: FrameKind.Data,
      payload: Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...title(1) })),
    });
    await barrier();
    expect(seen).toHaveLength(1);
    expect(states).toEqual(['connected']);
  });

  it('ends the subscription with ended when hc closes its event channel', async () => {
    const states: string[] = [];
    client.onConnection((state) => states.push(state));
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(3) });
    fake.end(fake.channels[0], { reason: 'server_stop' });
    await expect
      .poll(() => seen)
      .toEqual([title(3), { method: 'ended', params: { reason: 'closed' } }]);
    await barrier();
    expect(states).toEqual(['connected']);
  });

  it('reports a throwing notification consumer and keeps delivering', async () => {
    const logged: string[] = [];
    client.close();
    client = new NodeHcClient({ connect: fake.connect, log: (msg) => logged.push(msg) });
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => {
      seen.push(n);
      if (seen.length === 1) throw new Error('consumer bug');
    });
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(1) });
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(2) });
    await expect.poll(() => seen).toEqual([title(1), title(2)]);
    expect(logged).toHaveLength(1);
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

  it('passes non-contiguous sequence numbers through without re-subscribing', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({ labels: { lane: 'a' } }, (n) => seen.push(n));
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(4) });
    fake.notify(fake.channels[0], { jsonrpc: '2.0', ...title(9) });
    await expect.poll(() => seen).toEqual([title(4), title(9)]);
    expect(fake.calls.filter((call) => call.method === 'events.subscribe')).toHaveLength(1);
  });

  it('parses a large event split across many DATA frames once', async () => {
    const seen: HcNotification[] = [];
    await client.subscribe({}, (n) => seen.push(n));
    const big = {
      jsonrpc: '2.0',
      method: 'event',
      params: { seq: 1, type: 'title', terminal: 't1', data: { title: 'x{"\\}'.repeat(20000) } },
    } as const;
    const bytes = Buffer.from(JSON.stringify(big));
    const parse = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < bytes.byteLength; i += 1000)
      fake.send(fake.channels[0], bytes.subarray(i, i + 1000));
    await expect.poll(() => seen).toHaveLength(1);
    const eventParses = parse.mock.calls.filter(([text]) =>
      String(text).startsWith('{"jsonrpc":"2.0","method":"event"'),
    );
    parse.mockRestore();
    expect(eventParses).toHaveLength(1);
    expect(seen[0]).toEqual({ method: 'event', params: big.params });
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
