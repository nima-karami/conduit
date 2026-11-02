import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerCallError, ServerClient } from '../../electron/server-client';
import {
  APP_HELLO_TIMEOUT_MS,
  SERVER_PROTOCOL_GENERATION,
  type ServerEventEnvelope,
  type ServerSnapshot,
} from '../../src/contracts/server-protocol';
import { FakeC2Server } from './fake-c2-server';

let server: FakeC2Server | undefined;
let client: ServerClient | undefined;

async function setup(): Promise<{ server: FakeC2Server; client: ServerClient }> {
  server = new FakeC2Server();
  await server.listen();
  client = new ServerClient({ endpoint: server.endpoint, appVersion: '0.52.0', log: () => {} });
  return { server, client };
}

afterEach(async () => {
  vi.useRealTimers();
  client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

const rejection = async (p: Promise<unknown>): Promise<ServerCallError> => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ServerCallError)) throw new Error(`expected ServerCallError: ${error}`);
  return error;
};

describe('ServerClient', () => {
  it.each([false, true])(
    'installs batched snapshots before subsequent events (replacement=%s)',
    async (replacement) => {
      let subscriptions = 0;
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          const request = JSON.parse(String(chunk)) as { id: number; method: string };
          const seq = ++subscriptions * 10;
          const result =
            request.method === 'hello'
              ? { serverVersion: '1.0.0', generation: 1, instance: 'abc', pid: 1 }
              : { seq, sessions: [] };
          const messages: unknown[] = [{ jsonrpc: '2.0', id: request.id, result }];
          if (request.method === 'events.subscribe') {
            messages.push({
              jsonrpc: '2.0',
              method: 'event',
              params: { seq: seq + 1, type: 'attention.flash', data: { sessionId: 's' } },
            });
            if (replacement && subscriptions === 2)
              messages.push({
                jsonrpc: '2.0',
                method: 'event',
                params: { seq: seq + 2, type: 'missed', data: {} },
              });
          }
          this.push(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
          callback();
        },
      });
      client = new ServerClient({
        endpoint: 'memory',
        appVersion: '0.52.0',
        connect: () => socket,
        log: () => {},
      });
      const seen: string[] = [];
      await client.open();
      await client.subscribe({
        snapshot: (s) => seen.push(`snapshot:${s.seq}`),
        event: (e) => seen.push(`event:${e.seq}`),
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toEqual(
        replacement
          ? ['snapshot:20', 'event:21', 'snapshot:30', 'event:31']
          : ['snapshot:20', 'event:21'],
      );
    },
  );

  it('open resolves hello and sends generation', async () => {
    const { server, client } = await setup();
    const hello = await client.open();
    expect(hello.serverVersion).toBe('1.0.0');
    const [request] = server.calls('hello');
    expect(request.params).toEqual({
      appVersion: '0.52.0',
      generation: SERVER_PROTOCOL_GENERATION,
    });
  });

  it('call while closed rejects disconnected without writing', async () => {
    const { server, client } = await setup();
    const error = await rejection(client.call('sessions.remove', { sessionId: 's1' }));
    expect(error.kind).toBe('disconnected');
    let answerHello = () => {};
    const helloHeld = new Promise<void>((resolve) => {
      answerHello = resolve;
    });
    server.on('hello', async () => {
      await helloHeld;
      return { serverVersion: '1.0.0', generation: 1, instance: 'abc', pid: 1 };
    });
    const opening = client.open();
    await vi.waitFor(() => expect(server.calls('hello')).toHaveLength(1));
    const early = await rejection(client.call('sessions.remove', { sessionId: 's1' }));
    expect(early.kind).toBe('disconnected');
    answerHello();
    await opening;
    client.close();
    const after = await rejection(client.call('sessions.remove', { sessionId: 's1' }));
    expect(after.kind).toBe('disconnected');
    await new Promise((r) => setTimeout(r, 20));
    expect(server.calls('sessions.remove')).toEqual([]);
  });

  it('notify while closed returns false and writes nothing', async () => {
    const { server, client } = await setup();
    expect(client.notify('system.resumed', {})).toBe(false);
    server.silent = true;
    const early = new ServerClient({
      endpoint: server.endpoint,
      appVersion: '0.52.0',
      log: () => {},
    });
    const opening = early.open().catch(() => {});
    await vi.waitFor(() => expect(server.calls('hello')).toHaveLength(1));
    expect(early.notify('system.resumed', {})).toBe(false);
    early.close();
    await opening;
    server.silent = false;
    await client.open();
    expect(client.notify('term.input', { sessionId: 's1', generation: 1, data: 'a' })).toBe(true);
    await vi.waitFor(() => expect(server.calls('term.input')).toHaveLength(1));
    client.close();
    expect(client.notify('term.input', { sessionId: 's1', generation: 1, data: 'b' })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.calls('term.input')).toHaveLength(1);
    expect(server.calls('system.resumed')).toEqual([]);
  });

  it('-32000 maps data.kind', async () => {
    const { server, client } = await setup();
    server.on('sessions.create', () => {
      throw { code: -32000, message: 'stopping', data: { kind: 'server_stopping' } };
    });
    server.on('sessions.remove', () => {
      throw { code: -32601, message: 'Method not found' };
    });
    await client.open();
    const error = await rejection(client.call('sessions.create', { agentId: 'a', home: '/h' }));
    expect(error.kind).toBe('server_stopping');
    expect(error.message).toBe('stopping');
    const other = await rejection(client.call('sessions.remove', { sessionId: 's' }));
    expect(other.kind).toBe('protocol');
  });

  it('missed triggers events.subscribe and a second snapshot', async () => {
    const { server, client } = await setup();
    let subscribes = 0;
    server.on('events.subscribe', () => ({ seq: ++subscribes * 10, sessions: [] }));
    await client.open();
    const snapshots: ServerSnapshot[] = [];
    const events: ServerEventEnvelope[] = [];
    await client.subscribe({ snapshot: (s) => snapshots.push(s), event: (e) => events.push(e) });
    expect(snapshots.map((s) => s.seq)).toEqual([10]);
    server.event(11, 'missed', { seq: 11 });
    await vi.waitFor(() => expect(snapshots.map((s) => s.seq)).toEqual([10, 20]));
    expect(server.calls('events.subscribe')).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('events with seq <= snapshot.seq are dropped', async () => {
    const { server, client } = await setup();
    server.on('events.subscribe', () => ({ seq: 5, sessions: [] }));
    await client.open();
    const events: ServerEventEnvelope[] = [];
    await client.subscribe({ snapshot: () => {}, event: (e) => events.push(e) });
    server.event(4, 'attention.flash', { sessionId: 'old' });
    server.event(5, 'attention.flash', { sessionId: 'same' });
    // A gap (6, 7 went to another peer) is not a loss.
    server.event(8, 'attention.flash', { sessionId: 'new' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => [e.seq, e.data])).toEqual([[8, { sessionId: 'new' }]]);
  });

  it('hello timeout rejects timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { server, client } = await setup();
    server.silent = true;
    const opened = rejection(client.open());
    // Not vi.waitFor: under fake timers it advances them.
    while (server.calls('hello').length === 0) await new Promise((r) => setImmediate(r));
    vi.advanceTimersByTime(APP_HELLO_TIMEOUT_MS - 1);
    const early = await Promise.race([opened, Promise.resolve('pending')]);
    expect(early).toBe('pending');
    vi.advanceTimersByTime(1);
    expect((await opened).kind).toBe('timeout');
  });

  it('a peer close after hello reports eof and rejects pending calls', async () => {
    const { server, client } = await setup();
    server.on('sessions.remove', () => new Promise(() => {}));
    await client.open();
    const closed = new Promise((resolve) => client.onClose(resolve));
    const pending = rejection(client.call('sessions.remove', { sessionId: 's' }));
    await vi.waitFor(() => expect(server.calls('sessions.remove')).toHaveLength(1));
    server.dropClients();
    expect(await closed).toBe('eof');
    expect((await pending).kind).toBe('disconnected');
  });
});
