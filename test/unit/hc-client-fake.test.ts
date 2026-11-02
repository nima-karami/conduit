import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HcNotification, HcStreamEnd } from '../../src/contracts/hc';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';

let fake: FakeHc;
let client: NodeHcClient;
let port: number;
beforeEach(async () => {
  fake = new FakeHc();
  port = await fake.listen();
  client = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10 });
});
afterEach(async () => {
  client.close();
  await fake.close();
});
const run = (labels: Record<string, string> = {}) =>
  client.call('terminal.run', { argv: ['x'], labels, keep: false, no_parent: true });

describe('fake hc fidelity', () => {
  it('refuses to remove a live terminal', async () => {
    await expect(client.call('terminal.rm', { terminal: 't1' })).rejects.toMatchObject({
      name: 'HcRpcError',
      rawKind: 'live',
    });
    await client.call('terminal.kill', { terminal: 't1' });
    await expect(client.call('terminal.rm', { terminal: 't1' })).resolves.toEqual({
      removed: 't1',
    });
  });

  it('kill closes every attached channel after its queued data and notifies matching subscribers', async () => {
    const other = await run({ lane: 'other' });
    const seen: HcNotification[] = [];
    await client.subscribe({ terminal: 't1' }, (n) => seen.push(n));
    const active = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
    const observer = await client.attach({ terminal: 't1', cols: 80, rows: 24, observe: true });
    const bystander = await client.attach({ terminal: other.address, cols: 80, rows: 24 });
    fake.send(active.stream.channel, Buffer.alloc(300 * 1024, 66));
    const got: (number | HcStreamEnd)[] = [];
    const observerEnds: HcStreamEnd[] = [];
    const bystanderEnds: HcStreamEnd[] = [];
    active.stream.onClose((end) => got.push(end));
    observer.stream.onClose((end) => observerEnds.push(end));
    bystander.stream.onClose((end) => bystanderEnds.push(end));
    await client.call('terminal.kill', { terminal: 't1' });
    const killed = { reason: 'killed', exit_code: 1, signal: null };
    await expect.poll(() => observerEnds).toEqual([killed]);
    expect(got).toEqual([]);
    active.stream.onData((bytes) => {
      got.push(bytes.byteLength);
      active.stream.credit(bytes.byteLength);
    });
    await expect.poll(() => got.at(-1)).toEqual(killed);
    expect(got.slice(0, -1).reduce<number>((sum, n) => sum + Number(n), 0)).toBe(300 * 1024);
    await expect
      .poll(() => seen)
      .toEqual([
        {
          method: 'event',
          params: {
            // seq 1 was the other terminal's `created`, outside this filter: seq is core-wide.
            seq: 2,
            type: 'finished',
            terminal: 't1',
            data: { reason: 'killed', exit_code: 1, signal: null, finished_ms: expect.any(Number) },
          },
        },
      ]);
    await client.call('server.status', {});
    expect(bystanderEnds).toEqual([]);
  });

  it('answers an unknown method with JSON-RPC method-not-found', async () => {
    // The cast stands in for a method a newer caller knows and this core doesn't.
    await expect(client.call('no.such' as 'server.status', {})).rejects.toMatchObject({
      name: 'HcRpcError',
      code: -32601,
    });
  });

  it('refuses events.subscribe for an unknown terminal', async () => {
    await expect(client.subscribe({ terminal: 'nope' }, () => {})).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('spawns terminals at 200x120 by default', async () => {
    await expect(run()).resolves.toMatchObject({ cols: 200, rows: 120 });
  });

  it('destroys a connection whose framed bytes do not decode', async () => {
    await client.call('server.status', {});
    const socket = connect(port, '127.0.0.1');
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.on('error', () => {});
    // Without a reader the hello reply stays buffered and 'end' (hence 'close') never comes.
    socket.resume();
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {} })}\n`);
    socket.write(Buffer.from([0, 0, 0, 0, 99, 0, 0, 0, 0]));
    await closed;
  });
});
