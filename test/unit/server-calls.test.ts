import { describe, expect, it, vi } from 'vitest';
import {
  createServerCalls,
  installDownResult,
  installDownStatus,
  serverDownReply,
  waitForServerSnapshot,
} from '../../electron/server-calls';
import { ServerCallError, ServerClient } from '../../electron/server-client';
import type { ServerLifecycleState } from '../../electron/server-lifecycle';
import type { WebviewToHost } from '../../src/protocol';

describe('server-down typed replies', () => {
  const cases: { request: WebviewToHost; reply: object }[] = [
    {
      request: { type: 'brief:probe', path: '/brief', requestId: 37 },
      reply: { type: 'brief:probed', requestId: 37, ok: false, error: 'brief-io' },
    },
    {
      request: { type: 'brief:agentPreview', agentId: 'shell', requestId: 37 },
      reply: {
        type: 'brief:agentPreviewed',
        requestId: 37,
        supported: false,
        has: false,
        error: 'brief-io',
      },
    },
    {
      request: {
        type: 'launch:preview',
        agentId: 'shell',
        home: '/repo',
        roots: [],
        requestId: 37,
      },
      reply: {
        type: 'launch:previewResult',
        requestId: 37,
        skippedAddDirRoots: [],
        error: 'unresolvable',
      },
    },
    ...(['session:addDirsToAgent', 'session:restart'] as const).map((type) => ({
      request: { type, sessionId: 's', requestId: 37 },
      reply: {
        type: 'agentScope:result',
        requestId: 37,
        sessionId: 's',
        ok: false,
        reason: 'notReady',
      },
    })),
    {
      request: { type: 'launcher:addCustom', commandLine: 'shell', requestId: 37 },
      reply: {
        type: 'launcher:added',
        requestId: 37,
        error: "Conduit's background service is not connected",
      },
    },
    {
      request: { type: 'project:create', name: 'new', requestId: 37 },
      reply: { type: 'project:opResult', requestId: 37, ok: false, reason: 'store-unavailable' },
    },
  ];
  for (const kind of ['disconnected', 'timeout'] as const) {
    it.each(cases)(`${kind}: $request.type keeps the correlation id`, ({ request, reply }) => {
      expect(
        serverDownReply(
          request,
          new ServerCallError(kind, "Conduit's background service is not connected"),
        ),
      ).toEqual(reply);
    });
  }
  it('leaves unrelated errors to the handler', () => {
    expect(serverDownReply(cases[0].request, new Error('programming error'))).toBeUndefined();
    expect(
      serverDownReply(cases[0].request, new ServerCallError('refused', 'invalid-path')),
    ).toBeUndefined();
  });
  it.each(['disconnected', 'timeout'] as const)('returns complete install rows for %s', (kind) => {
    const error = new ServerCallError(kind, 'down');
    const status = installDownStatus(error);
    expect(status.clis.map((s) => s.cli)).toEqual(['claude', 'codex', 'cursor', 'opencode']);
    expect(status.clis.every((s) => s.user.state === 'error' && s.user.errorCode === kind)).toBe(
      true,
    );
    expect(installDownResult({ cli: 'codex', scope: 'user', action: 'install' }, error)).toEqual({
      ok: false,
      status: status.clis[1],
      errorCode: kind,
    });
  });
});

describe('OS open snapshot wait', () => {
  it.each(['unavailable', 'stopped', 'downgrade'] as const)(
    'ends a pending wait on %s',
    async (terminal) => {
      let current: ServerLifecycleState = { state: 'connecting' };
      let listener: (s: ServerLifecycleState) => void = () => {};
      const off = vi.fn();
      const wait = waitForServerSnapshot(new Promise<void>(() => {}), {
        current: () => current,
        onState: (cb) => {
          listener = cb;
          return off;
        },
      });
      const result = wait.then(
        () => 'resolved',
        () => 'refused',
      );
      current =
        terminal === 'downgrade'
          ? { state: terminal, serverVersion: '99' }
          : terminal === 'stopped'
            ? { state: terminal, reason: 'gone', logPath: '/log' }
            : { state: terminal, reason: 'exhausted', logPath: '/log' };
      listener(current);
      await Promise.resolve();
      await Promise.resolve();
      expect(await Promise.race([result, Promise.resolve('still pending')])).toBe('refused');
      expect(off).toHaveBeenCalledOnce();
    },
  );
  it('refuses immediately when the lifecycle has already stopped', async () => {
    const wait = waitForServerSnapshot(new Promise<void>(() => {}), {
      current: () => ({ state: 'downgrade', serverVersion: '99' }),
      onState: () => () => {},
    });
    const result = wait.then(
      () => 'resolved',
      () => 'refused',
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(await Promise.race([result, Promise.resolve('still pending')])).toBe('refused');
  });
  it('releases the lifecycle listener after a snapshot arrives', async () => {
    const off = vi.fn();
    await waitForServerSnapshot(Promise.resolve(), {
      current: () => ({ state: 'connecting' }),
      onState: () => off,
    });
    expect(off).toHaveBeenCalledOnce();
  });
});

describe('server connection waits', () => {
  it('releases all pending calls on a connection and cancels their deadlines', async () => {
    vi.useFakeTimers();
    try {
      const calls = createServerCalls(() => null);
      const first = calls.whenConnected(50);
      const second = calls.whenConnected(50);
      const client = new ServerClient({ endpoint: '/unused', appVersion: '1', log: () => {} });
      calls.connected(client);
      await expect(first).resolves.toBe(client);
      await expect(second).resolves.toBe(client);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses pending calls when startup reaches an unavailable state', async () => {
    const calls = createServerCalls(() => null);
    const reply = calls.whenConnected().catch((error: unknown) => error);
    calls.stateChanged({ state: 'unavailable', reason: 'exhausted', logPath: '/log' });
    await expect(reply).resolves.toMatchObject({ kind: 'disconnected' });
  });
  it('bounds a reconnect wait by its deadline', async () => {
    vi.useFakeTimers();
    try {
      const calls = createServerCalls(() => ({
        current: () => ({ state: 'reconnecting' }),
        client: () => null,
      }));
      const reply = calls.whenConnected(50).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      await expect(reply).resolves.toMatchObject({ kind: 'disconnected' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
