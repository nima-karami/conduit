import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopAll } from '../../server/lifecycle/stop-all';
import {
  STOP_ALL_ANSWER_TIMEOUT_MS,
  STOP_ALL_CONNECT_TIMEOUT_MS,
} from '../../src/contracts/server-protocol';

function harness() {
  const socket = new Socket();
  const requests: Record<string, unknown>[] = [];
  vi.spyOn(socket, 'write').mockImplementation((data) => {
    requests.push(JSON.parse(String(data)));
    return true;
  });
  const directFallback = vi.fn(async () => 7);
  const result = stopAll({
    endpoint: '/pipe',
    version: '0.52.0',
    directFallback,
    connect: () => socket,
  });
  const hello = () => {
    socket.emit('connect');
    socket.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverVersion: '0.52.0', generation: 1, instance: 'abc', pid: 1 } })}\n`,
      ),
    );
  };
  return { socket, requests, result, hello, directFallback };
}

describe('uninstall stop-all client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('falls back if no connection is made within five seconds', async () => {
    const x = harness();
    await vi.advanceTimersByTimeAsync(STOP_ALL_CONNECT_TIMEOUT_MS);
    expect(await x.result).toEqual({ ok: true, killed: 7, fallback: true });
    expect(x.directFallback).toHaveBeenCalledTimes(1);
    expect(x.socket.destroyed).toBe(true);
  });

  it('falls back if a connected server never answers hello', async () => {
    const x = harness();
    x.socket.emit('connect');
    expect(x.requests[0]?.method).toBe('hello');
    await vi.advanceTimersByTimeAsync(STOP_ALL_CONNECT_TIMEOUT_MS);
    expect(await x.result).toMatchObject({ ok: true, fallback: true });
    expect(x.directFallback).toHaveBeenCalledTimes(1);
  });

  it('reports failure after twenty seconds for an accepted stop without touching hc', async () => {
    const x = harness();
    x.hello();
    expect(x.requests.map((r) => r.method)).toEqual(['hello', 'server.stopAll']);
    await vi.advanceTimersByTimeAsync(STOP_ALL_ANSWER_TIMEOUT_MS - 1);
    expect(x.directFallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await x.result).toEqual({ ok: false, reason: 'server.stopAll answer timeout' });
    expect(x.directFallback).not.toHaveBeenCalled();
  });

  it('returns the stop result and cancels every timeout', async () => {
    const x = harness();
    x.hello();
    x.socket.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"killed":4}}\n'));
    expect(await x.result).toEqual({ ok: true, killed: 4, fallback: false });
    await vi.advanceTimersByTimeAsync(STOP_ALL_ANSWER_TIMEOUT_MS * 2);
    expect(x.directFallback).not.toHaveBeenCalled();
  });

  it('falls back exactly once if the connection closes before the stop reply (C2/F12)', async () => {
    const x = harness();
    x.hello();
    x.socket.emit('close');
    expect(await x.result).toEqual({ ok: true, killed: 7, fallback: true });
    expect(x.directFallback).toHaveBeenCalledTimes(1);
  });

  it('reports an explicit stop error without racing the server with fallback', async () => {
    const x = harness();
    x.hello();
    x.socket.emit(
      'data',
      Buffer.from('{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"persist failed"}}\n'),
    );
    expect(await x.result).toEqual({ ok: false, reason: 'persist failed' });
    expect(x.directFallback).not.toHaveBeenCalled();
  });
});
