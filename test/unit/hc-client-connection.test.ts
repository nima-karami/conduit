import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRAME_MAX_PAYLOAD, FrameKind } from '../../src/contracts/frames';
import type { HcNotification, HcStreamEnd } from '../../src/contracts/hc';
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

describe('hc connection lifecycle', () => {
  it('ends the affected stream disconnected when its CLOSE payload is malformed', async () => {
    const { stream } = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
    const ends: HcStreamEnd[] = [];
    stream.onClose((end) => ends.push(end));
    fake.sendFrame({
      channel: stream.channel,
      kind: FrameKind.Close,
      payload: Buffer.from('invalid JSON'),
    });
    await expect.poll(() => ends).toEqual([{ reason: 'disconnected' }]);
  });

  it('rejects pending calls and closes every stream disconnected without losing buffered data', async () => {
    const { stream } = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
    const { stream: observer } = await client.attach({
      terminal: 't1',
      cols: 80,
      rows: 24,
      observe: true,
    });
    fake.send(stream.channel, Buffer.from('last bytes'));
    await client.call('server.status', {});
    fake.onCall('terminal.get', () => new Promise(() => {}));
    const failure = expect(client.call('terminal.get', { terminal: 't1' })).rejects.toMatchObject({
      name: 'HcDisconnectedError',
      reason: 'disconnected',
    });
    await expect.poll(() => fake.calls.at(-1)?.method).toBe('terminal.get');
    const received: (string | HcStreamEnd)[] = [];
    const observerEnds: HcStreamEnd[] = [];
    stream.onClose((end) => received.push(end));
    observer.onClose((end) => observerEnds.push(end));
    fake.disconnect();
    await failure;
    await expect.poll(() => observerEnds).toEqual([{ reason: 'disconnected' }]);
    expect(received).toEqual([]);
    stream.onData((bytes) => received.push(Buffer.from(bytes).toString()));
    expect(received).toEqual(['last bytes', { reason: 'disconnected' }]);
  });

  it('emits reconnected after fresh hello and lets the caller obtain a new subscription snapshot', async () => {
    const states: string[] = [];
    const oldNotifications: HcNotification[] = [];
    client.onConnection((state, hello) => {
      states.push(state);
      if (state === 'reconnected') expect(hello?.core.id).toBe('replacement');
    });
    const old = await client.subscribe({}, (n) => oldNotifications.push(n));
    fake.hello.core.id = 'replacement';
    fake.seq = 0;
    fake.terminals[0].title = 'after restart';
    fake.disconnect();
    await expect.poll(() => states).toEqual(['connected', 'lost', 'reconnected']);
    expect(fake.calls.filter((call) => call.method === 'hello')).toHaveLength(2);
    expect(fake.calls.filter((call) => call.method === 'events.subscribe')).toHaveLength(1);
    const fresh: HcNotification[] = [];
    const sub = await client.subscribe({}, (n) => fresh.push(n));
    expect(sub.snapshot[0].title).toBe('after restart');
    old.close();
    fake.notify(fake.channels[1], {
      jsonrpc: '2.0',
      method: 'event',
      params: { seq: 1, type: 'title', terminal: 't1', data: { title: 'new' } },
    });
    await expect.poll(() => fresh).toHaveLength(1);
    expect(oldNotifications).toEqual([]);
  });

  it('disconnects on an oversized wire header and on peer data exceeding granted credit', async () => {
    const states: string[] = [];
    client.onConnection((state) => states.push(state));
    const { stream } = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
    const ends: HcStreamEnd[] = [];
    stream.onClose((end) => ends.push(end));
    const header = Buffer.alloc(9);
    header.writeUInt32LE(FRAME_MAX_PAYLOAD + 1, 5);
    fake.raw(header);
    await expect.poll(() => ends).toEqual([{ reason: 'disconnected' }]);
    await expect.poll(() => states.at(-1)).toBe('reconnected');
    const next = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
    const nextEnds: HcStreamEnd[] = [];
    next.stream.onClose((end) => nextEnds.push(end));
    fake.sendFrame({
      channel: next.stream.channel,
      kind: FrameKind.Data,
      payload: Buffer.alloc(262145),
    });
    await expect.poll(() => nextEnds).toEqual([{ reason: 'disconnected' }]);
  });

  it('reports lost once while the core stays down, then reconnected when it returns', async () => {
    const states: string[] = [];
    client.onConnection((state) => states.push(state));
    await client.call('server.status', {});
    await fake.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(states).toEqual(['connected', 'lost']);
    await fake.listen();
    await expect.poll(() => states).toEqual(['connected', 'lost', 'reconnected']);
  });

  it('close cancels reconnect, rejects queued calls, and disposes connection listeners', async () => {
    await client.call('server.status', {});
    const states: string[] = [];
    const remove = client.onConnection((state) => states.push(state));
    remove();
    client.close();
    await expect(client.call('server.status', {})).rejects.toMatchObject({
      name: 'HcDisconnectedError',
    });
    expect(states).toEqual([]);
    expect(fake.calls.filter((call) => call.method === 'hello')).toHaveLength(1);
  });

  it('handles a fragmented plain hello and fragmented framed response', async () => {
    client.close();
    const socket = fake.connect();
    const transport = new Duplex({
      read() {},
      write(bytes, encoding, callback) {
        socket.write(bytes, encoding, callback);
      },
      destroy(error, callback) {
        socket.destroy();
        callback(error);
      },
    });
    socket.on('data', (bytes: Buffer) => {
      for (let i = 0; i < bytes.byteLength; i += 3) transport.push(bytes.subarray(i, i + 3));
    });
    client = new NodeHcClient({ connect: () => transport });
    await expect(client.call('terminal.get', { terminal: 't1' })).resolves.toMatchObject({
      address: 't1',
    });
  });
});
