import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHcEvents } from '../../electron/hc-events';
import type { HcEvent } from '../../src/contracts/hc';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';

let fake: FakeHc;
let client: NodeHcClient;
let events: ReturnType<typeof createHcEvents>;
const LABELS = { 'conduit.instance': 'abc' };
const ours = () => ({ ...fake.terminals[0], labels: { ...LABELS } });

beforeEach(async () => {
  fake = new FakeHc();
  await fake.listen();
  fake.terminals[0].labels = { ...LABELS };
  client = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10 });
  events = createHcEvents(client, LABELS, () => {});
});
afterEach(async () => {
  events.close();
  client.close();
  await fake.close();
});

const subscribes = () => fake.calls.filter((c) => c.method === 'events.subscribe');
const sizeOf = (e: HcEvent) => (e.type === 'size' ? e.data : null);

describe('createHcEvents', () => {
  it('subscribes once with the instance labels and routes events by terminal', async () => {
    await events.ready();
    expect(subscribes().map((c) => c.params)).toEqual([{ labels: LABELS }]);
    const t1: HcEvent[] = [];
    const t9: HcEvent[] = [];
    events.on('t1', (e) => t1.push(e));
    events.on('t9', (e) => t9.push(e));
    fake.emit(ours(), 'size', { cols: 90, rows: 30 });
    await vi.waitFor(() => expect(t1.map(sizeOf)).toEqual([{ cols: 90, rows: 30 }]));
    expect(t9).toEqual([]);
  });

  it('an unsubscribed listener gets nothing more', async () => {
    await events.ready();
    const seen: HcEvent[] = [];
    const off = events.on('t1', (e) => seen.push(e));
    fake.emit(ours(), 'title', { title: 'a' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    off();
    fake.emit(ours(), 'title', { title: 'b' });
    await client.call('server.status', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
  });

  it('missed re-subscribes and later events still arrive', async () => {
    await events.ready();
    const seen: HcEvent[] = [];
    events.on('t1', (e) => seen.push(e));
    fake.notify(fake.channels[0], {
      jsonrpc: '2.0',
      method: 'missed',
      params: { seq: 1, terminals: [] },
    });
    await vi.waitFor(() => expect(subscribes()).toHaveLength(2));
    await vi.waitFor(() => expect(fake.channels).toHaveLength(2));
    await client.call('server.status', {});
    fake.emit(ours(), 'title', { title: 'after' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
  });

  it('a core reconnect re-subscribes', async () => {
    await events.ready();
    const seen: HcEvent[] = [];
    events.on('t1', (e) => seen.push(e));
    fake.disconnect();
    await vi.waitFor(() => expect(subscribes().length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(async () => {
      fake.emit(ours(), 'title', { title: 'back' });
      await client.call('server.status', {});
      expect(seen.length).toBeGreaterThan(0);
    });
  });
});
