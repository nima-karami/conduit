import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as endpoint from '../../server/mcp/endpoint';
import { createServices } from '../../server/services';
import { toolError } from '../../src/conduit-mcp/types';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';
import { instanceNames } from '../../src/instance-names';
import { SessionActivity } from '../../src/session-activity';
import type { AgentDefinition } from '../../src/types';
import { allowPeerReset } from '../helpers/peer-socket';
import { testEndpoint } from '../helpers/test-endpoint';

const shell: AgentDefinition = {
  id: 'test-shell',
  label: 'Shell',
  command: 'sh',
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
};
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

async function harness(settings: Record<string, unknown> = {}, tokenBlob?: string) {
  const scratch = path.join(os.tmpdir(), 'Codex-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const userData = fs.mkdtempSync(path.join(scratch, 'server-recovery-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ version: 1, settings }));
  if (tokenBlob !== undefined) {
    fs.mkdirSync(path.join(userData, 'conduit-mcp'));
    fs.writeFileSync(path.join(userData, 'conduit-mcp', 'tokens.json'), tokenBlob);
  }
  const fake = new FakeHc();
  await fake.listen();
  const events: string[] = [];
  const names = {
    ...instanceNames(userData, process.platform === 'win32' ? 'win32' : 'posix', os.tmpdir(), {
      home: '/home/conduit-test',
      uid: 1000,
      runtimeDir: '',
    }),
    mcpEndpoint: testEndpoint(),
  };
  const build = () =>
    createServices({
      userData,
      names,
      platform: process.platform,
      e2e: true,
      appVersion: '9.9.9',
      logPath: path.join(userData, 'server.log'),
      env: {},
      homeDir: userData,
      hc: new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10, log: () => {} }),
      startCore: async () => {},
      shim: { execPath: process.execPath, shimPath: path.join(userData, 'shim.cjs') },
      emit: (type) => events.push(type),
      emitTo: () => {},
      stopping: () => false,
      onHealth: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      detectShells: () => [shell],
      detectClis: () => [],
      resolveCommand: (c) => c,
    });
  let services = build();
  const rpc = async (method: string, params: unknown) => {
    const answer = await services.dispatch({ id: 1, method, params }, { subscribed: true });
    if ('error' in answer) throw answer.error;
    if (!('result' in answer)) throw new Error('RPC did not return a reply');
    return answer.result;
  };
  cleanup.push(async () => {
    await services.close();
    await fake.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  return {
    userData,
    fake,
    names,
    events,
    rpc,
    get services() {
      return services;
    },
    async create() {
      return (
        (await rpc('sessions.create', { agentId: shell.id, home: userData })) as {
          sessionId: string;
        }
      ).sessionId;
    },
    async restart(beforeStart?: () => void) {
      await services.core.persist();
      await services.close();
      services = build();
      beforeStart?.();
      await services.core.start();
    },
  };
}

it.each(['messaging-off', 'endpoint-down'])(
  'durably adopts a %s launch through a fresh server',
  async (mode) => {
    if (mode === 'endpoint-down')
      vi.spyOn(endpoint, 'createShimEndpoint').mockReturnValue({
        listen: async () => ({ ok: false, error: toolError('store_unavailable', 'listen failed') }),
        close: async () => {},
      });
    const h = await harness({ conduitMcp: mode !== 'messaging-off' });
    await h.services.core.start();
    const id = await h.create();
    await h.rpc('sessions.start', { sessionId: id });
    const first = h.services.runtime.get(id);
    expect(first).toBeDefined();
    expect(h.fake.calls.find((c) => c.method === 'terminal.run')?.params.env).not.toHaveProperty(
      'CONDUIT_SESSION_TOKEN',
    );
    await h.restart();
    expect(h.services.runtime.get(id)?.target).toEqual(first?.target);
    expect(h.fake.calls.filter((c) => c.method === 'terminal.run')).toHaveLength(1);
  },
);

it('restores MCP adoption after held restore-off records and before listening', async () => {
  const h = await harness({ restoreSessions: false });
  await h.services.core.start();
  const id = await h.create();
  await h.rpc('sessions.start', { sessionId: id });
  const token = h.fake.calls.find((c) => c.method === 'terminal.run')?.params.env as Record<
    string,
    string
  >;
  await h.restart();
  const terminal = h.services.runtime.get(id);
  expect(terminal).toBeDefined();
  if (!terminal) throw new Error('adopted terminal missing');
  h.services.mcp.termInput({ sessionId: id, generation: terminal.generation, data: 'codex\r' });
  const socket = allowPeerReset(net.connect(h.names.mcpEndpoint));
  cleanup.push(() => {
    socket.destroy();
  });
  socket.write(
    `${JSON.stringify({ conduit: 2, token: token.CONDUIT_SESSION_TOKEN, shim: 'test', resume: { initialize: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client' } }, initialized: true } })}\n`,
  );
  const bindingsFile = path.join(h.userData, 'conduit-mcp', 'bindings.json');
  await expect
    .poll(() =>
      fs.existsSync(bindingsFile) ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8')).bindings : [],
    )
    .toEqual([
      expect.objectContaining({ sessionId: id, generation: terminal.generation, cli: 'codex' }),
    ]);
});

it.each(['finished', 'lost'])(
  'records a recovered %s launch and clears its token and binding',
  async (state) => {
    const h = await harness();
    await h.services.core.start();
    const id = await h.create();
    await h.rpc('sessions.start', { sessionId: id });
    const first = h.services.runtime.get(id);
    if (!first) throw new Error('started terminal missing');
    await h.services.core.persist();
    await h.services.close();
    const record = h.fake.terminals.find((t) => t.address === first.target.terminal);
    if (!record) throw new Error('hc terminal missing');
    record.state = 'finished';
    record.exit_code = 23;
    record.reason = 'exited';
    if (state === 'lost') h.fake.terminals.splice(h.fake.terminals.indexOf(record), 1);
    fs.writeFileSync(
      path.join(h.userData, 'conduit-mcp', 'bindings.json'),
      JSON.stringify({
        version: 1,
        bindings: [
          {
            sessionId: id,
            generation: first.generation,
            cli: 'codex',
            clientInfoName: 'codex-mcp-client',
          },
        ],
      }),
    );
    await h.restart();
    expect(h.services.core.snapshot().sessions.find((s) => s.id === id)).toMatchObject({
      status: 'exited',
      exitCode: state === 'lost' ? null : 23,
    });
    expect(h.services.mcp.tokens.rows()).toEqual({ state: 'loaded', rows: [] });
    expect(
      JSON.parse(fs.readFileSync(path.join(h.userData, 'conduit-mcp', 'bindings.json'), 'utf8'))
        .bindings,
    ).toEqual([]);
  },
);

it('fences a failed recovery lookup, refuses start, and retries next reconcile', async () => {
  const h = await harness();
  await h.services.core.start();
  const id = await h.create();
  await h.rpc('sessions.start', { sessionId: id });
  const first = h.services.runtime.get(id);
  if (!first) throw new Error('started terminal missing');
  let fail = true;
  h.fake.onCall('terminal.get', (p) => {
    if (fail) throw new Error('transient lookup');
    return h.fake.terminals.find((t) => t.address === p.terminal || t.name === p.terminal);
  });
  await h.restart();
  expect(await h.rpc('sessions.start', { sessionId: id })).toMatchObject({
    ok: false,
    refusal: { reason: 'spawn_unconfirmed', launchId: first.launchId },
  });
  expect(h.fake.calls.filter((c) => c.method === 'terminal.run')).toHaveLength(1);
  fail = false;
  await h.services.runtime.reconcile();
  expect(h.services.runtime.get(id)?.target).toEqual(first.target);
});

it('forgets attention on repeated create/start/remove', async () => {
  const h = await harness();
  await h.services.core.start();
  const forget = vi.spyOn(SessionActivity.prototype, 'forget');
  for (let i = 0; i < 3; i++) {
    const id = await h.create();
    await h.rpc('sessions.start', { sessionId: id });
    await h.rpc('sessions.remove', { sessionId: id });
    expect(forget).toHaveBeenCalledWith(id);
    const tracker = forget.mock.contexts.at(-1) as SessionActivity | undefined;
    expect(tracker?.trackedCount()).toBe(0);
    expect(h.services.attention.lastOutputAt(id)).toBeUndefined();
  }
});

it('refuses to run when the token reservation cannot be durable', async () => {
  const h = await harness({}, '{corrupt tokens');
  await h.services.core.start();
  const id = await h.create();
  await expect(h.rpc('sessions.start', { sessionId: id })).rejects.toThrow(
    'token store unreadable',
  );
  expect(h.fake.calls.filter((c) => c.method === 'terminal.run')).toHaveLength(0);
});

it('publishes one combined sessions.changed for domain and attention invalidation', async () => {
  const h = await harness();
  await h.services.core.start();
  await new Promise((r) => setTimeout(r, 350));
  h.events.length = 0;
  const id = await h.create();
  await h.rpc('sessions.start', { sessionId: id });
  await new Promise((r) => setTimeout(r, 350));
  expect(h.events.filter((e) => e === 'sessions.changed')).toHaveLength(1);
});

it('holds the shutdown persistence barrier until scrollback writes finish and propagates failure', async () => {
  const h = await harness();
  await h.services.core.start();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(h.services.scrollback, 'flushPending').mockImplementation(() => delayed);
  let persisted = false;
  const barrier = h.services.core.persist().then(() => {
    persisted = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(persisted).toBe(false);
  release();
  await barrier;
  vi.mocked(h.services.scrollback.flushPending).mockImplementation(async () => {
    throw new Error('disk failed');
  });
  await expect(h.services.core.persist()).rejects.toThrow('disk failed');
});

it('does not credit a late attach after the shutdown ring snapshot', async () => {
  const h = await harness();
  await h.services.core.start();
  const id = await h.create();
  h.fake.paint = Buffer.from('late attach bytes');
  const attach = NodeHcClient.prototype.attach;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attached = false;
  vi.spyOn(NodeHcClient.prototype, 'attach').mockImplementation(async function (
    this: NodeHcClient,
    options,
  ) {
    const result = await attach.call(this, options);
    attached = true;
    await gate;
    return result;
  });
  const append = vi.spyOn(h.services.scrollback, 'append');
  const starting = h.rpc('sessions.start', { sessionId: id });
  await vi.waitFor(() => expect(attached).toBe(true));
  await h.services.core.persist();
  const credited = append.mock.calls.length;
  release();
  await starting;
  expect(append.mock.calls).toHaveLength(credited);
});
