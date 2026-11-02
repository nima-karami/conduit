import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose, emptySnapshot } from '../../server/compose';
import type { ShellCore } from '../../server/lifecycle/shell';
import { STOP_FAILED_EXIT } from '../../server/lifecycle/shell';
import { PipeTransport, type RpcHandler } from '../../server/transport/pipe';
import { APP_HELLO_TIMEOUT_MS } from '../../src/contracts/server-protocol';
import { instanceNames } from '../../src/instance-names';

const sockets: Socket[] = [];
const transports: PipeTransport[] = [];
const directories: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const transport of transports.splice(0)) await transport.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(options: { dispatch?: RpcHandler; eventBufferBound?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'w3-test-pipe-'));
  directories.push(dir);
  const names = instanceNames(dir, process.platform === 'win32' ? 'win32' : 'posix', tmpdir());
  const onError = vi.fn();
  const transport = new PipeTransport(
    names.serverEndpoint,
    process.platform === 'win32' ? 'win32' : 'posix',
    onError,
    ...(options.eventBufferBound === undefined ? [] : [options.eventBufferBound]),
  );
  transports.push(transport);
  const core: ShellCore = {
    start: vi.fn<ShellCore['start']>(() => new Promise(() => {})),
    beginStopping: vi.fn(async () => {}),
    killSessions: vi.fn(async () => 3),
    persist: vi.fn(async () => {}),
    idleState: vi.fn(async () => ({ liveTerminals: 0, pendingTimers: false, busyTokens: false })),
    snapshot: emptySnapshot,
  };
  const exit = vi.fn();
  const writeLog = vi.fn();
  const shell = compose({
    transport,
    core,
    version: '0.52.0',
    instance: names.instance,
    logPath: '/log',
    exit,
    writeLog,
    ...(options.dispatch ? { dispatch: options.dispatch } : {}),
  });
  disposers.push(() => shell.lifecycle.dispose());
  expect(await transport.listen(shell.handle)).toBe(true);
  shell.lifecycle.start();
  return { names, core, transport, shell, exit, writeLog, onError };
}

async function client(endpoint: string) {
  const socket = createConnection(endpoint);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffer = '';
  const inbox: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const value: unknown = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiting.shift();
      if (waiter) waiter(value);
      else inbox.push(value);
    }
  });
  let id = 0;
  const next = () =>
    inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve));
  return {
    socket,
    next,
    send(method: string, params: unknown = {}) {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
    },
    async call(method: string, params: unknown = {}) {
      this.send(method, params);
      return next();
    },
  };
}

const hello = { appVersion: '0.52.0', generation: 1 };

describe('server shell on the real C2 pipe', () => {
  it('binds before slow core startup and a second owner loses without starting core work', async () => {
    const x = await setup();
    const second = new PipeTransport(
      x.names.serverEndpoint,
      process.platform === 'win32' ? 'win32' : 'posix',
    );
    transports.push(second);
    expect(await second.listen(x.shell.handle)).toBe(false);
    expect(x.core.start).toHaveBeenCalledTimes(1);
    const c = await client(x.names.serverEndpoint);
    expect(await c.call('hello', hello)).toMatchObject({
      result: { serverVersion: '0.52.0', generation: 1, instance: x.names.instance },
    });
  });

  it('answers hello and a starting snapshot before the core is ready; streams versioned events', async () => {
    const x = await setup();
    const c = await client(x.names.serverEndpoint);
    expect(await c.call('hello', hello)).toMatchObject({ result: { pid: process.pid } });
    expect(await c.call('events.subscribe')).toMatchObject({
      result: { runtime: { state: 'starting' }, seq: 0 },
    });
    x.transport.emit('runtime.changed', { state: 'ready', hcVersion: '0.1.16' });
    expect(await c.next()).toEqual({
      jsonrpc: '2.0',
      method: 'event',
      params: { seq: 1, type: 'runtime.changed', data: { state: 'ready', hcVersion: '0.1.16' } },
    });
    expect(x.transport.peers.size).toBe(1);
  });

  it('uses versionOrder to reject an older app restart while allowing its stopAll', async () => {
    const x = await setup();
    const c = await client(x.names.serverEndpoint);
    await c.call('hello', { ...hello, appVersion: '0.51.0' });
    expect([...x.transport.peers.values()][0]?.order).toBe('appOlder');
    expect(await c.call('server.restart', { reason: 'update' })).toMatchObject({
      error: { code: -32000, data: { kind: 'refused' } },
    });
    expect(await c.call('server.stopAll')).toMatchObject({ result: { killed: 3 } });
  });

  it('allows a newer app restart, persists and flushes the reply before exit', async () => {
    const x = await setup();
    const c = await client(x.names.serverEndpoint);
    await c.call('hello', { ...hello, appVersion: '0.53.0' });
    expect([...x.transport.peers.values()][0]?.order).toBe('appNewer');
    expect(await c.call('server.restart', { reason: 'update' })).toMatchObject({ result: {} });
    await vi.waitFor(() => expect(x.exit).toHaveBeenCalledWith(0));
    expect(x.core.persist).toHaveBeenCalledTimes(1);
    expect(x.core.killSessions).not.toHaveBeenCalled();
  });

  it('refuses create and start while stopAll settles pending launches, then replies and exits', async () => {
    const x = await setup();
    let settle: () => void = () => {};
    vi.mocked(x.core.beginStopping).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const c = await client(x.names.serverEndpoint);
    await c.call('hello', hello);
    expect(x.shell.logging).toEqual({ logging: true, logLevel: 'info' });
    c.send('server.stopAll');
    await vi.waitFor(() => expect(x.core.beginStopping).toHaveBeenCalledWith('stopAll'));
    expect(await c.call('sessions.create', { agentId: 'shell', home: '/x' })).toMatchObject({
      error: { data: { kind: 'server_stopping' } },
    });
    expect(await c.call('sessions.start', { sessionId: 's' })).toMatchObject({
      result: { ok: false, refusal: { reason: 'server_stopping' } },
    });
    expect(await c.call('sessions.retryLaunch', { sessionId: 's' })).toMatchObject({
      result: { ok: false, refusal: { reason: 'server_stopping' } },
    });
    settle();
    expect(await c.next()).toMatchObject({ result: { killed: 3 } });
    await vi.waitFor(() => expect(x.exit).toHaveBeenCalledWith(3));
  });

  it('keeps logging defaults until server.setLogging', async () => {
    const x = await setup();
    const c = await client(x.names.serverEndpoint);
    await c.call('hello', hello);
    x.shell.log('info', 'first');
    expect(x.writeLog).toHaveBeenCalledTimes(1);
    expect(await c.call('server.setLogging', { logging: false, logLevel: 'debug' })).toMatchObject({
      result: {},
    });
    expect(x.shell.logging).toEqual({ logging: false, logLevel: 'debug' });
    x.shell.log('error', 'disabled');
    expect(x.writeLog).toHaveBeenCalledTimes(1);
  });

  it('closes connections which never send hello within APP_HELLO_TIMEOUT_MS', async () => {
    const x = await setup();
    vi.useFakeTimers();
    try {
      const c = await client(x.names.serverEndpoint);
      await vi.waitFor(() => expect(x.transport.peers.size).toBe(1));
      await vi.advanceTimersByTimeAsync(APP_HELLO_TIMEOUT_MS);
      await vi.waitFor(() => expect(c.socket.destroyed).toBe(true));
      await vi.waitFor(() => expect(x.transport.peers.size).toBe(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses fragmented UTF-8 lines and keeps standard JSON-RPC protocol errors', async () => {
    const x = await setup();
    const c = await client(x.names.serverEndpoint);
    c.socket.write('garbage\n');
    expect(await c.next()).toMatchObject({ id: null, error: { code: -32700 } });
    const line = Buffer.from(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'utf8',
        method: 'hello',
        params: { ...hello, appVersion: '0.52.0+λ' },
      })}\n`,
    );
    const split = line.indexOf(Buffer.from('λ')) + 1;
    c.socket.write(line.subarray(0, split));
    c.socket.write(line.subarray(split));
    expect(await c.next()).toMatchObject({ id: 'utf8', result: { serverVersion: '0.52.0' } });
    expect(await c.call('unknown.method')).toMatchObject({ error: { code: -32601 } });
  });

  it('replies a failed stop with its error, then exits with a crash code', async () => {
    const x = await setup();
    vi.mocked(x.core.persist).mockRejectedValueOnce(new Error('persist failed'));
    const c = await client(x.names.serverEndpoint);
    await c.call('hello', hello);
    expect(await c.call('server.stopAll')).toMatchObject({
      error: { code: -32603, message: 'persist failed' },
    });
    await vi.waitFor(() => expect(x.exit).toHaveBeenCalledWith(STOP_FAILED_EXIT));
  });

  it('leaves a stopAll that arrives during a restart persist unanswered until the exit closes it', async () => {
    const x = await setup();
    x.exit.mockImplementation(() => x.transport.close());
    let persisted: () => void = () => {};
    vi.mocked(x.core.persist).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          persisted = resolve;
        }),
    );
    const app = await client(x.names.serverEndpoint);
    await app.call('hello', hello);
    app.send('server.restart', { reason: 'update' });
    await vi.waitFor(() => expect(x.core.persist).toHaveBeenCalled());
    const uninstall = await client(x.names.serverEndpoint);
    await uninstall.call('hello', hello);
    const closed = new Promise<void>((resolve) => uninstall.socket.once('close', () => resolve()));
    let answered: unknown;
    void uninstall.call('server.stopAll').then((value) => {
      answered = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    persisted();
    expect(await app.next()).toMatchObject({ result: {} });
    await closed;
    expect(answered).toBeUndefined();
    expect(x.core.killSessions).not.toHaveBeenCalled();
    expect(x.exit).toHaveBeenCalledWith(0);
  });

  it('reports notification handler failures instead of swallowing them', async () => {
    const x = await setup({
      dispatch: () => {
        throw new Error('term.input broke');
      },
    });
    const c = await client(x.names.serverEndpoint);
    await c.call('hello', hello);
    c.socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'term.input', params: { data: 'x' } })}\n`,
    );
    await vi.waitFor(() => expect(x.onError).toHaveBeenCalledWith(new Error('term.input broke')));
  });

  it('drops a stalled subscriber with missed {seq} and resumes only after events.subscribe', async () => {
    const x = await setup({ eventBufferBound: 64 * 1024 });
    const c = await client(x.names.serverEndpoint);
    await c.call('hello', hello);
    await c.call('events.subscribe');
    c.socket.pause();
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 200; i += 1)
      x.transport.emit('runtime.changed', { state: 'unavailable', reason: chunk, logPath: '' });
    const lastSeq = x.transport.seq;
    c.socket.resume();
    const received: { params: { seq: number; type: string; data: unknown } }[] = [];
    while (received.length < 200 && received.at(-1)?.params.type !== 'missed')
      received.push((await c.next()) as (typeof received)[number]);
    const missed = received.at(-1)?.params;
    expect(missed?.type).toBe('missed');
    expect(missed?.data).toEqual({ seq: missed?.seq });
    x.transport.emit('runtime.changed', { state: 'ready', hcVersion: 'dropped' });
    expect(await c.call('events.subscribe')).toMatchObject({ result: { seq: lastSeq + 1 } });
    x.transport.emit('runtime.changed', { state: 'ready', hcVersion: 'after' });
    expect(await c.next()).toMatchObject({
      params: { type: 'runtime.changed', data: { hcVersion: 'after' } },
    });
  });
});
