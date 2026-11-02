import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipeTransport } from '../../server/transport/pipe';

const state = vi.hoisted(() => ({
  errors: [] as (string | undefined)[],
  probe: 'ECONNREFUSED',
  binds: 0,
  unlink: vi.fn(async (_path: string) => {}),
}));
vi.mock('node:fs/promises', () => ({ unlink: state.unlink }));
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    createServer: () => {
      const server = Object.assign(new EventEmitter(), {
        listening: false,
        listen: () => {
          state.binds++;
          const code = state.errors.shift();
          queueMicrotask(() => {
            if (code) server.emit('error', Object.assign(new Error(code), { code }));
            else {
              server.listening = true;
              server.emit('listening');
            }
          });
          return server;
        },
        close: (callback: () => void) => {
          server.listening = false;
          callback();
        },
      });
      const listen = server.listen;
      server.listen = (...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === 'function') server.once('listening', () => callback());
        return listen();
      };
      return server;
    },
    createConnection: () => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      queueMicrotask(() => {
        if (state.probe === 'live') socket.emit('connect');
        else socket.emit('error', Object.assign(new Error(state.probe), { code: state.probe }));
      });
      return socket;
    },
  };
});

beforeEach(() => {
  state.errors = ['EADDRINUSE', undefined];
  state.probe = 'ECONNREFUSED';
  state.binds = 0;
  state.unlink.mockClear();
});

describe('POSIX socket lock recovery independent of host OS', () => {
  it('unlinks only a refused stale socket then retries the bind', async () => {
    const transport = new PipeTransport('/profile/conduit-server.sock', 'posix');
    expect(await transport.listen(async () => ({ result: {} }))).toBe(true);
    expect(state.unlink).toHaveBeenCalledWith('/profile/conduit-server.sock');
    expect(state.binds).toBe(2);
    await transport.close();
  });

  it('does not unlink or replace a live socket owner', async () => {
    state.probe = 'live';
    const transport = new PipeTransport('/profile/conduit-server.sock', 'posix');
    expect(await transport.listen(async () => ({ result: {} }))).toBe(false);
    expect(state.unlink).not.toHaveBeenCalled();
    expect(state.binds).toBe(1);
  });

  it('does not treat inaccessible endpoints as stale', async () => {
    state.probe = 'EACCES';
    const transport = new PipeTransport('/profile/conduit-server.sock', 'posix');
    await expect(transport.listen(async () => ({ result: {} }))).rejects.toMatchObject({
      code: 'EACCES',
    });
    expect(state.unlink).not.toHaveBeenCalled();
  });

  it('treats EADDRINUSE on Windows as a losing instance without probing or unlinking', async () => {
    const transport = new PipeTransport('pipe', 'win32');
    expect(await transport.listen(async () => ({ result: {} }))).toBe(false);
    expect(state.unlink).not.toHaveBeenCalled();
    expect(state.binds).toBe(1);
  });
});
