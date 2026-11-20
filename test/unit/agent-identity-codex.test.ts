import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCodexIdentityAdapter } from '../../src/agent-identity/codex';
import type { CodexServer } from '../../src/agent-identity/codex-process';
import {
  type CodexEvents,
  CodexRpcError,
  type JsonObject,
} from '../../src/agent-identity/codex-rpc';
import type {
  AgentIdentityLaunch,
  ConversationReference,
} from '../../src/contracts/agent-identity';

const PRIMARY = '12345678-aaaa-4aaa-8aaa-123456789abc';
const OTHER = '12345678-bbbb-4bbb-8bbb-123456789abc';
const scope = { cwd: resolve('project'), storageHome: resolve('codex-home'), machineId: 'm-local' };
const mcp = 'mcp_servers.conduit.command="conduit"';

function launch(generation = 1, argv = ['--sandbox', 'read-only', '-a', 'never', '-c', mcp]) {
  const abort = new AbortController();
  const value: AgentIdentityLaunch = {
    ids: { generation, launchId: `id-${generation}` },
    scope,
    signal: abort.signal,
    sessionId: 'test',
    env: {},
    command: 'codex',
    argv,
  };
  const ref: ConversationReference = {
    version: 1,
    adapterId: 'codex',
    scope,
    capturedAt: value.ids,
    conversationId: PRIMARY,
  };
  return { value, ref, abort };
}

function fakeServer() {
  const request = vi.fn(async (method: string, params: JsonObject): Promise<JsonObject> => {
    if (method === 'thread/read') {
      return { thread: { id: params.threadId, cwd: scope.cwd, name: 'Saved' } };
    }
    if (method === 'thread/loaded/list') return { data: [PRIMARY] };
    return {};
  });
  const peers: CodexEvents[] = [];
  let exit: (() => void) | undefined;
  const server: CodexServer = {
    tuiArgs: ['--remote', 'unix:///private/codex.sock'],
    connect: async (events) => {
      peers.push(events);
      return { request, close: () => undefined };
    },
    onExit: (listener) => {
      exit = listener;
    },
    close: vi.fn(),
  };
  return { request, peers, server, exit: () => exit?.() };
}

const observer = () => ({ bind: vi.fn(), rename: vi.fn(), unbind: vi.fn() });

describe('Codex identity', () => {
  it('pins the first parent, preserves launch config, and ignores secondary thread names', async () => {
    const fake = fakeServer();
    const start = vi.fn(async () => fake.server);
    const adapter = createCodexIdentityAdapter({ start });
    const { value, ref, abort } = launch();
    const sink = observer();
    await adapter.observe(value, sink);
    const result = await adapter.fresh(value, 'Initial');
    expect(result.argv).toEqual([...fake.server.tuiArgs, ...value.argv]);
    expect(start).toHaveBeenCalledWith(
      value,
      ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', mcp],
      value.argv,
      expect.any(String),
    );
    const events = fake.peers[0];
    events.notify('thread/started', { thread: { id: OTHER, forkedFromId: PRIMARY } });
    expect(sink.bind).not.toHaveBeenCalled();
    events.notify('thread/started', { thread: { id: PRIMARY } });
    events.notify('thread/started', { thread: { id: OTHER } });
    expect(sink.bind.mock.calls).toEqual([[PRIMARY]]);
    events.notify('thread/name/updated', { threadId: OTHER, threadName: 'Other' });
    expect(sink.rename).not.toHaveBeenCalled();
    await adapter.setName(ref, 'Host', 3);
    expect(fake.request.mock.calls).toEqual([
      ['thread/name/set', { threadId: PRIMARY, name: 'Initial' }],
      ['thread/name/set', { threadId: PRIMARY, name: 'Host' }],
    ]);
    events.notify('thread/name/updated', { threadId: PRIMARY, threadName: 'Host' });
    events.notify('thread/name/updated', { threadId: PRIMARY, threadName: 'Native' });
    expect(sink.rename.mock.calls).toEqual([
      [{ conversationId: PRIMARY, name: 'Host', source: 'native' }],
      [{ conversationId: PRIMARY, name: 'Native', source: 'native' }],
    ]);
    abort.abort();
    expect(fake.server.close).toHaveBeenCalledOnce();
    await expect(adapter.setName(ref, 'Stale', 4)).rejects.toThrow('Stale');
  });

  it('composes exact resume and keeps native permissions on the owning server', async () => {
    const fake = fakeServer();
    const start = vi.fn(async () => fake.server);
    const adapter = createCodexIdentityAdapter({ start });
    const { value, abort } = launch(2);
    const sink = observer();
    await adapter.observe(value, sink);
    const result = await adapter.resume(value, launch().ref, 'Committed');
    expect(result.argv).toEqual(['resume', ...fake.server.tuiArgs, '-c', mcp, PRIMARY]);
    expect(fake.request).toHaveBeenCalledWith('thread/name/set', {
      threadId: PRIMARY,
      name: 'Committed',
    });
    expect(sink.bind).toHaveBeenCalledWith(PRIMARY);
    abort.abort();
  });

  it('reconciles after reconnect and fences superseded notifications and exit', async () => {
    const first = fakeServer();
    const second = fakeServer();
    const start = vi
      .fn<typeof import('../../src/agent-identity/codex-process').startCodexServer>()
      .mockResolvedValueOnce(first.server)
      .mockResolvedValueOnce(second.server);
    const adapter = createCodexIdentityAdapter({ start });
    const oldLaunch = launch();
    const oldSink = observer();
    await adapter.observe(oldLaunch.value, oldSink);
    await adapter.fresh(oldLaunch.value, 'Initial');
    const old = first.peers[0];
    old.notify('thread/started', { thread: { id: PRIMARY } });
    old.disconnected();
    await vi.waitFor(() =>
      expect(oldSink.rename).toHaveBeenCalledWith({
        conversationId: PRIMARY,
        name: 'Saved',
        source: 'native',
      }),
    );
    old.notify('thread/name/updated', { threadId: PRIMARY, threadName: 'Stale peer' });
    const next = launch(2);
    const nextSink = observer();
    await adapter.observe(next.value, nextSink);
    await adapter.fresh(next.value, 'Next');
    expect(first.server.close).toHaveBeenCalledOnce();
    first.exit();
    expect(oldSink.unbind).not.toHaveBeenCalled();
    second.peers[0].notify('thread/started', { thread: { id: PRIMARY } });
    second.exit();
    expect(nextSink.unbind).toHaveBeenCalledExactlyOnceWith('server-exited');
    next.abort.abort();
    oldLaunch.abort.abort();
  });

  it('invalidates only when the primary is archived or deleted', async () => {
    const fake = fakeServer();
    const adapter = createCodexIdentityAdapter({ start: async () => fake.server });
    const { value, ref, abort } = launch();
    const sink = observer();
    await adapter.observe(value, sink);
    await adapter.fresh(value, 'Initial');
    const events = fake.peers[0];
    events.notify('thread/started', { thread: { id: PRIMARY } });
    events.notify('thread/archived', { threadId: OTHER });
    expect(sink.unbind).not.toHaveBeenCalled();
    events.notify('thread/deleted', { threadId: PRIMARY });
    expect(sink.unbind).toHaveBeenCalledExactlyOnceWith('primary-deleted');
    await expect(adapter.setName(ref, 'Unsafe', 1)).rejects.toThrow('unavailable');
    abort.abort();
  });

  it('adopts the saved primary and refuses a reference from a different launch', async () => {
    const fake = fakeServer();
    const start = vi.fn(async () => fake.server);
    const adapter = createCodexIdentityAdapter({ start, rendezvousDir: '/private/rendezvous' });
    const { value, ref, abort } = launch();
    const sink = observer();

    await adapter.adopt(value, ref, sink);
    expect(start).toHaveBeenCalledWith(value, [], [], '/private/rendezvous', true);
    expect(sink.bind).toHaveBeenCalledExactlyOnceWith(PRIMARY);
    expect(sink.rename).toHaveBeenCalledExactlyOnceWith({
      conversationId: PRIMARY,
      name: 'Saved',
      source: 'native',
    });
    await adapter.setName(ref, 'After adoption', 1);
    expect(fake.request).toHaveBeenCalledWith('thread/name/set', {
      threadId: PRIMARY,
      name: 'After adoption',
    });
    abort.abort();

    const next = launch(2);
    const nextSink = observer();
    await adapter.adopt(next.value, ref, nextSink);
    expect(start).toHaveBeenCalledOnce();
    expect(nextSink.unbind).toHaveBeenCalledExactlyOnceWith('server-exited');
    next.abort.abort();
  });

  it('requires positive identity and cwd evidence for exact resume', async () => {
    const readSaved = vi
      .fn()
      .mockResolvedValueOnce({ thread: { id: OTHER, cwd: scope.cwd } })
      .mockResolvedValueOnce({ thread: { id: PRIMARY, cwd: scope.storageHome } })
      .mockRejectedValueOnce(new CodexRpcError(-32600, `no rollout found for thread id ${PRIMARY}`))
      .mockResolvedValueOnce({ thread: { id: PRIMARY, cwd: scope.cwd } });
    const adapter = createCodexIdentityAdapter({ readSaved });
    const { ref } = launch();
    await expect(adapter.exists(ref)).resolves.toBe('unavailable');
    await expect(adapter.exists(ref)).resolves.toBe('unavailable');
    await expect(adapter.exists(ref)).resolves.toBe('missing');
    await expect(adapter.exists(ref)).resolves.toBe('present');
  });
});
