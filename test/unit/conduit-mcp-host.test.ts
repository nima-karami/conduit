import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConduitMcpHost,
  type ConduitMcpHostDeps,
  createConduitMcpHost,
  ENDPOINT_READY_WAIT_MS,
} from '../../electron/conduit-mcp-host';
import { createSessionScreens } from '../../electron/session-screens';
import { ECHO_POLL_MS } from '../../src/conduit-mcp/notice-gate';
import { composeNotice } from '../../src/conduit-mcp/notice-text';
import type { StoreIo } from '../../src/conduit-mcp/store';
import { toolError } from '../../src/conduit-mcp/types';
import type { HostToWebview } from '../../src/protocol';
import { createPtyWriter } from '../../src/pty-writer';
import type { AgentDefinition, Session, SpawnSpec } from '../../src/types';
import { testEndpoint } from '../helpers/test-endpoint';

const FAKE: AgentDefinition = {
  id: 'e2e-fake-mcp',
  label: 'Fake MCP',
  command: '/usr/bin/node',
  args: ['fake.mjs'],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
};
const SHELL: AgentDefinition = { ...FAKE, id: 'pwsh', command: 'pwsh' };
const CODEX: AgentDefinition = { ...FAKE, id: 'codex', command: '/usr/bin/codex' };
const CURSOR: AgentDefinition = { ...FAKE, id: 'cursor', command: '/usr/bin/agent' };
const spec = (command = '/usr/bin/node'): SpawnSpec => ({
  command,
  args: ['fake.mjs'],
  cwd: '/w',
  env: { A: '1' },
});

const noLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}
function recordingLog() {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry['level']) => (scope: string, msg: string, data?: Record<string, unknown>) => {
      entries.push({ level, scope, msg, data });
    };
  return {
    entries,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    of: (msg: string) => entries.filter((e) => e.msg === msg),
  };
}

interface Harness {
  host: ConduitMcpHost;
  dir: string;
  ep: string;
  clock: { t: number };
  sessions: Map<string, Session>;
  inputs: Array<[string, string]>;
  echo: Set<string>;
  busy: Set<string>;
  lastOut: Map<string, number>;
  broadcasts: HostToWebview[];
  calls: string[];
  alive: Set<string>;
  gens: Map<string, number>;
  writer: ReturnType<typeof createPtyWriter>;
  /** Gap releases, when the harness holds submit gaps. */
  gaps: Array<() => void>;
}

const dirs: string[] = [];
const hosts: ConduitMcpHost[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: `S ${id}`,
    agentId: 'e2e-fake-mcp',
    home: '/w',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...extra,
  };
}

function harness(
  opts: {
    dir?: string;
    messagingOn?: () => boolean;
    storeIo?: StoreIo;
    listen?: boolean;
    platform?: ConduitMcpHostDeps['platform'];
    holdGaps?: boolean;
    /** Typed text shows on screen only at the host's next wait, as Codex renders it (measured). */
    lagEcho?: boolean;
    /** The fake prompt answers an Enter with a fresh empty prompt line. */
    echoSubmit?: boolean;
    /** Runs inside the host's wait between echo polls, i.e. while the Enter is still pending. */
    duringWait?: (host: ConduitMcpHost) => void;
    tickMs?: number;
    log?: ConduitMcpHostDeps['log'];
    createEndpoint?: ConduitMcpHostDeps['createEndpoint'];
  } = {},
): Harness {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-host-'));
  if (!opts.dir) dirs.push(dir);
  const ep = testEndpoint();
  const clock = { t: 1_000_000 };
  const sessions = new Map<string, Session>();
  const inputs: Array<[string, string]> = [];
  const echo = new Set<string>();
  const busy = new Set<string>();
  const lastOut = new Map<string, number>();
  const broadcasts: HostToWebview[] = [];
  const calls: string[] = [];
  const alive = new Set<string>();
  const gens = new Map<string, number>();
  const gaps: Array<() => void> = [];
  const lagged: Array<[string, string]> = [];
  let tokenN = 0;
  let host: ConduitMcpHost;
  const writer = createPtyWriter({
    generation: (id) => gens.get(id),
    input: (id, data) => {
      inputs.push([id, data]);
      // The PTY echoes typed text back, which the host's screen model then shows.
      if (!echo.has(id)) return true;
      if (data === '\r') {
        if (opts.echoSubmit) host.onOutput(id, '\r\nfake❯ ');
      } else if (opts.lagEcho) lagged.push([id, data]);
      else host.onOutput(id, data);
      return true;
    },
    sleep: () => (opts.holdGaps ? new Promise<void>((r) => gaps.push(r)) : Promise.resolve()),
    gapMs: 0,
  });
  host = createConduitMcpHost({
    dir,
    homeDir: dir,
    endpointPath: ep,
    execPath: '/opt/conduit/conduit',
    shimPath: '/opt/conduit/resources/conduit-mcp/conduit-mcp-shim.cjs',
    platform: opts.platform ?? 'linux',
    e2e: true,
    mgr: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
      setMcp: (id, patch) => {
        const s = sessions.get(id);
        if (!s) return false;
        const counters = fs.existsSync(path.join(dir, 'handles.json'))
          ? fs.readFileSync(path.join(dir, 'handles.json'), 'utf8')
          : '';
        calls.push(`setMcp ${JSON.stringify(patch)} handles=${counters.replace(/\s/g, '')}`);
        Object.assign(s, patch);
        return true;
      },
    },
    pty: {
      isAlive: (id) => alive.has(id),
      generation: (id) => gens.get(id),
    },
    writer,
    activity: {
      statusOf: (id) => ({ busy: busy.has(id), needsAttention: false, completedRun: false }),
      lastOutputAt: (id) => lastOut.get(id),
    },
    messagingOn: opts.messagingOn ?? (() => true),
    projectName: () => null,
    broadcast: (m) => broadcasts.push(m),
    log: opts.log ?? noLog,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      opts.duringWait?.(host);
      for (const [id, data] of lagged.splice(0)) host.onOutput(id, data);
    },
    randomToken: () => `tok${++tokenN}`,
    storeIo: opts.storeIo,
    screens: createSessionScreens(),
    listen: opts.listen ?? true,
    tickMs: opts.tickMs ?? 0,
    createEndpoint: opts.createEndpoint,
  });
  hosts.push(host);
  return {
    host,
    dir,
    ep,
    clock,
    sessions,
    inputs,
    echo,
    busy,
    lastOut,
    broadcasts,
    calls,
    alive,
    gens,
    writer,
    gaps,
  };
}

/** A minimal JSON-RPC client over the endpoint, as the shim + CLI would be. */
async function client(ep: string, token: string | null) {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(ep, () => resolve(s));
    s.on('error', reject);
  });
  sockets.push(sock);
  sock.setEncoding('utf8');
  let buf = '';
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      waiting.get(msg.id as number)?.(msg);
      i = buf.indexOf('\n');
    }
  });
  sock.write(`${JSON.stringify({ conduit: 1, token })}\n`);
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', { protocolVersion: '2025-06-18' });
  const call = async (name: string, args: unknown = {}) => {
    const r = (await request('tools/call', { name, arguments: args })) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    return { isError: r.result.isError === true, body: JSON.parse(r.result.content[0].text) };
  };
  return { request, call, sock };
}

/** A client that sends only the hello: the test drives every request, initialize included. */
async function helloOnly(ep: string, token: string | null) {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(ep, () => resolve(s));
    s.on('error', reject);
  });
  sockets.push(sock);
  sock.setEncoding('utf8');
  const closed = new Promise<void>((r) => sock.on('close', () => r()));
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      waiting.get(msg.id as number)?.(msg);
      i = buf.indexOf('\n');
    }
  });
  sock.write(`${JSON.stringify({ conduit: 1, token })}\n`);
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(id, resolve);
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { request, closed };
}

/** Launch a fake session through prepareLaunch + onSpawn, returning its token. */
function launch(h: Harness, id: string, def = FAKE, sp = spec()) {
  if (!h.sessions.has(id)) h.sessions.set(id, session(id, { agentId: def.id }));
  const out = h.host.prepareLaunch(id, def, sp);
  h.alive.add(id);
  h.gens.set(id, (h.gens.get(id) ?? 0) + 1);
  h.host.onSpawn(id, 40, 24);
  return { spec: out, token: out.env?.CONDUIT_SESSION_TOKEN ?? null };
}

/** Bring a session to an open gate: settled, quiet, idle prompt on screen, connected. */
async function ready(h: Harness, id: string) {
  const { token } = launch(h, id);
  const c = await client(h.ep, token);
  h.host.onOutput(id, 'fake❯ ');
  h.echo.add(id);
  return c;
}

const settle = (h: Harness) => {
  h.clock.t += 5_000;
};

const writesTo = (h: Harness, id: string) => h.inputs.filter(([s]) => s === id).map(([, d]) => d);

async function lastState(h: Harness) {
  await expect.poll(() => h.broadcasts.length, { timeout: 2_000 }).toBeGreaterThan(0);
  return h.host.uiState();
}

describe('createConduitMcpHost — launch', () => {
  it('leaves Cursor launch unchanged and reports cursor-not-connected without the user entry', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    const original = spec('/usr/bin/agent');
    expect(h.host.prepareLaunch('c1', CURSOR, original)).toBe(original);
    expect(h.host.uiState().sessions.c1?.unavailable).toBe('cursor-not-connected');
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'missing token placeholder',
      JSON.stringify({
        mcpServers: {
          conduit: { env: { CONDUIT_MCP_ENDPOINT: '${env:CONDUIT_MCP_ENDPOINT}' } },
        },
      }),
    ],
    [
      'missing endpoint placeholder',
      JSON.stringify({
        mcpServers: {
          conduit: { env: { CONDUIT_SESSION_TOKEN: '${env:CONDUIT_SESSION_TOKEN}' } },
        },
      }),
    ],
  ])('leaves Cursor launch unchanged for %s', async (_label, contents) => {
    const h = harness();
    const cursorDir = path.join(h.dir, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, 'mcp.json'), contents);
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    const original = spec('/usr/bin/agent');
    expect(h.host.prepareLaunch('c1', CURSOR, original)).toBe(original);
    expect(h.host.uiState().sessions.c1?.unavailable).toBe('cursor-not-connected');
  });

  it('wires Cursor with no args when a stale user entry has both env placeholders', async () => {
    const h = harness();
    const cursorDir = path.join(h.dir, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          conduit: {
            command: '/old/conduit',
            args: ['old-shim'],
            env: {
              CONDUIT_SESSION_TOKEN: '${env:CONDUIT_SESSION_TOKEN}',
              CONDUIT_MCP_ENDPOINT: '${env:CONDUIT_MCP_ENDPOINT}',
            },
          },
        },
      }),
    );
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    const original = spec('/usr/bin/agent');
    const out = h.host.prepareLaunch('c1', CURSOR, original);
    expect(out.args).toEqual(original.args);
    expect(out.env).toMatchObject({ CONDUIT_SESSION_TOKEN: 'tok1', CONDUIT_MCP_ENDPOINT: h.ep });
    expect(h.host.uiState().sessions.c1?.unavailable).toBeNull();
  });

  it('prepareLaunch for fake adds --mcp-config and a token; config file written without the token; env has no ELECTRON_RUN_AS_NODE', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    const out = h.host.prepareLaunch('s1', FAKE, spec());
    const cfgPath = path.join(h.dir, 'launch', 's1.json');
    expect(out.args?.slice(0, 3)).toEqual(['fake.mjs', '--mcp-config', cfgPath]);
    expect(out.args?.[3]).toBe('--allowedTools');
    expect(out.args).toHaveLength(5);
    expect(out.env).toEqual({ A: '1', CONDUIT_SESSION_TOKEN: 'tok1', CONDUIT_MCP_ENDPOINT: h.ep });
    expect(out.env && 'ELECTRON_RUN_AS_NODE' in out.env).toBe(false);
    const cfg = fs.readFileSync(cfgPath, 'utf8');
    expect(cfg).not.toContain('tok1');
    expect(JSON.parse(cfg).mcpServers.conduit.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(h.sessions.get('s1')?.mcpHandle).toBe('fake-1');
  });

  it('the token value reaches only the PTY env: never args or a config file', async () => {
    const h = harness();
    await h.host.start();
    for (const [id, def, cmd] of [
      ['s1', FAKE, '/usr/bin/node'],
      ['s2', CODEX, '/usr/bin/codex'],
    ] as const) {
      h.sessions.set(id, session(id, { agentId: def.id }));
      const out = h.host.prepareLaunch(id, def, spec(cmd));
      const token = out.env?.CONDUIT_SESSION_TOKEN;
      expect(token).toMatch(/^tok\d+$/);
      expect(out.args.join(' ')).not.toContain(token);
      const cfg = path.join(h.dir, 'launch', `${id}.json`);
      if (fs.existsSync(cfg)) expect(fs.readFileSync(cfg, 'utf8')).not.toContain(token);
    }
    expect(fs.existsSync(path.join(h.dir, 'launch', 's1.json'))).toBe(true);
  });

  it('prepareLaunch for a plain shell returns spec unchanged', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1', { agentId: 'pwsh' }));
    const sp = spec('/usr/bin/pwsh');
    expect(h.host.prepareLaunch('s1', SHELL, sp)).toBe(sp);
    expect(h.sessions.get('s1')?.mcpHandle).toBeUndefined();
    expect(h.host.uiState().sessions).toEqual({});
  });

  it('messaging off → unchanged + unavailable messaging-off', async () => {
    const h = harness({ messagingOn: () => false });
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    const sp = spec();
    expect(h.host.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1).toMatchObject({
      handle: 'fake-1',
      unavailable: 'messaging-off',
      gate: null,
    });
  });

  it('guard trip → unchanged + unavailable cmd-metachar', async () => {
    const h = harness({ platform: 'win32' });
    await h.host.start();
    const id = 'a&b';
    h.sessions.set(id, session(id));
    const sp = spec('C:\\npm\\fake.cmd');
    expect(h.host.prepareLaunch(id, FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions[id]?.unavailable).toBe('cmd-metachar');
  });

  it('handle allocation writes handles.json before setMcp', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    h.host.prepareLaunch('s1', FAKE, spec());
    expect(h.calls).toEqual(['setMcp {"mcpHandle":"fake-1"} handles={"fake":1}']);
  });

  it('a kept handle is not re-allocated; a duplicate holder gets a new one', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    h.host.prepareLaunch('s1', FAKE, spec());
    h.host.prepareLaunch('s1', FAKE, spec());
    expect(h.calls).toHaveLength(1);
    h.sessions.set('s2', session('s2', { mcpHandle: 'fake-1' }));
    h.host.prepareLaunch('s2', FAKE, spec());
    expect(h.sessions.get('s2')?.mcpHandle).toBe('fake-2');
  });

  it('onExit revokes the token and deletes the launch config', async () => {
    const h = harness();
    await h.host.start();
    const { token } = launch(h, 's1');
    const c = await client(h.ep, token);
    const closed = new Promise<void>((r) => c.sock.on('close', () => r()));
    const cfg = path.join(h.dir, 'launch', 's1.json');
    expect(fs.existsSync(cfg)).toBe(true);
    h.host.onExit('s1');
    await closed;
    await expect.poll(() => fs.existsSync(cfg)).toBe(false);
    const again = await client(h.ep, token);
    expect((await again.call('list_sessions')).body.error.code).toBe('not_in_session');
  });

  it('a connection that said hello but had not initialized does not survive the exit', async () => {
    const h = harness();
    await h.host.start();
    const { token } = launch(h, 's1');
    const c = await helloOnly(h.ep, token);
    const list = (await c.request(1, 'tools/list')) as { result: { tools: unknown[] } };
    expect(list.result.tools.length).toBeGreaterThan(0);
    h.host.onExit('s1');
    h.alive.delete('s1');
    await c.closed;
    expect(h.host.uiState().sessions.s1?.connected).toBe(false);
  });

  it('initialize on a connection whose token was re-minted does not make the session live', async () => {
    const h = harness();
    await h.host.start();
    const { token } = launch(h, 's1');
    const c = await helloOnly(h.ep, token);
    await c.request(1, 'tools/list');
    h.host.prepareLaunch('s1', FAKE, spec());
    const init = c.request(2, 'initialize', { protocolVersion: '2025-06-18' });
    await Promise.race([init, c.closed]);
    await c.closed;
    expect(h.host.uiState().sessions.s1?.connected).toBe(false);
  });

  it('a revoked token is refused by an already-initialized connection', async () => {
    const h = harness();
    await h.host.start();
    const { token } = launch(h, 's1');
    const c = await client(h.ep, token);
    h.host.prepareLaunch('s1', FAKE, spec());
    const r = await c.call('list_sessions');
    expect(r.body.error.code).toBe('not_in_session');
  });

  it('a handles.json or launch-config write failure → unchanged + unavailable launch-io', async () => {
    const h = harness();
    await h.host.start();
    fs.mkdirSync(path.join(h.dir, 'handles.json'));
    h.sessions.set('s1', session('s1'));
    const sp = spec();
    expect(h.host.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    fs.rmSync(path.join(h.dir, 'handles.json'), { recursive: true });
    h.sessions.set('s2', session('s2'));
    fs.mkdirSync(path.join(h.dir, 'launch', 's2.json'), { recursive: true });
    expect(h.host.prepareLaunch('s2', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s2?.unavailable).toBe('launch-io');
  });

  it('a launch before the endpoint listens gets no wiring and reads endpoint-down', async () => {
    const h = harness();
    h.sessions.set('s1', session('s1'));
    const sp = spec();
    expect(h.host.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    await h.host.start();
    const wired = h.host.prepareLaunch('s1', FAKE, sp);
    expect(wired.env?.CONDUIT_SESSION_TOKEN).toBeDefined();
    expect(h.host.uiState().sessions.s1?.unavailable).toBeNull();
  });

  it('the endpoint listens before the store loads', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const io: StoreIo = {
      readLog: async () => {
        await gate;
        return undefined;
      },
      appendLog: async () => {},
      rewriteLog: async () => {},
      writeBlob: async () => {},
      readBlob: async () => undefined,
      deleteBlob: async () => {},
      listBlobs: async () => [],
      sweepPartialBlobs: async () => {},
    };
    const h = harness({ storeIo: io });
    const started = h.host.start();
    await expect
      .poll(() => {
        h.sessions.set('s1', session('s1'));
        return h.host.prepareLaunch('s1', FAKE, spec()).env?.CONDUIT_SESSION_TOKEN;
      })
      .toBeDefined();
    expect(h.host.uiState().loading).toBe(true);
    release();
    await started;
  });

  it('a tick that throws is logged, not left unhandled', async () => {
    const errors: string[] = [];
    const h = harness({
      tickMs: 5,
      log: { ...noLog, error: (_scope, msg) => errors.push(msg) },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await h.host.start();
      launch(h, 's1');
      // The activity tracker is read only by the tick, so the throw stays inside it.
      h.busy.has = () => {
        throw new Error('boom');
      };
      await expect.poll(() => errors.length, { timeout: 2_000 }).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('start sweeps launch configs left by a crash', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.dir, 'launch'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'launch', 'old.json'), '{}');
    await h.host.start();
    expect(fs.existsSync(path.join(h.dir, 'launch', 'old.json'))).toBe(false);
  });
});

describe('createConduitMcpHost — tools over the endpoint', () => {
  it('a socket with a valid token sends; recipient gets queued; mcp:state broadcast', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    launch(h, 's2');
    const c = await client(h.ep, a.token);
    const sessions = await c.call('list_sessions');
    expect(sessions.body.sessions.map((s: { handle: string }) => s.handle)).toEqual([
      'fake-1',
      'fake-2',
    ]);
    const sent = await c.call('send_message', { to: ['fake-2'], body: 'hi' });
    expect(sent.isError).toBe(false);
    expect(sent.body.recipients).toEqual([{ handle: 'fake-2', status: 'queued' }]);
    const st = await lastState(h);
    expect(h.broadcasts.some((b) => b.type === 'mcp:state')).toBe(true);
    expect(st.sessions.s2?.unread).toBe(1);
    expect(st.threads).toHaveLength(1);
  });

  it('invalid token → tools/list [] and not_in_session', async () => {
    const h = harness();
    await h.host.start();
    launch(h, 's1');
    const c = await client(h.ep, 'forged');
    const list = (await c.request('tools/list')) as { result: { tools: unknown[] } };
    expect(list.result.tools).toEqual([]);
    expect((await c.call('send_message', { to: ['fake-1'], body: 'x' })).body.error.code).toBe(
      'not_in_session',
    );
    const none = await client(h.ep, null);
    expect((await none.call('list_sessions')).body.error.code).toBe('not_in_session');
  });

  it('logs calls rejected before the tool runs', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    await h.host.start();
    const a = launch(h, 's1');
    const forged = await client(h.ep, 'forged');
    await forged.call('list_sessions');
    const c = await client(h.ep, a.token);
    await c.call('list_sessions');
    expect(rec.of('tool call').map((e) => e.data)).toEqual([
      { tool: 'list_sessions', handle: undefined, ok: false, code: 'not_in_session' },
      { tool: 'list_sessions', handle: 'fake-1', ok: true },
    ]);
  });

  it('messaging turned off → messaging_off', async () => {
    let on = true;
    const h = harness({ messagingOn: () => on });
    await h.host.start();
    const a = launch(h, 's1');
    const c = await client(h.ep, a.token);
    on = false;
    expect((await c.call('list_sessions')).body.error.code).toBe('messaging_off');
  });

  it('mcp:compose as you', async () => {
    const h = harness();
    await h.host.start();
    launch(h, 's1');
    const replies: HostToWebview[] = [];
    await h.host.handleRenderer(
      {
        type: 'mcp:compose',
        requestId: 7,
        to: ['fake-1'],
        body: 'from the human',
        priority: 'normal',
        kind: 'request',
      },
      (m) => replies.push(m),
    );
    expect(replies).toHaveLength(1);
    const r = replies[0];
    expect(r.type === 'mcp:sent' && r.requestId === 7 && r.result.ok).toBe(true);
    const st = h.host.uiState();
    expect(st.threads[0]?.participants).toEqual(expect.arrayContaining(['you', 'fake-1']));
    expect(st.sessions.s1?.unread).toBe(1);
  });

  it('onSessionDeleted marks unread undelivered', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    launch(h, 's2');
    const c = await client(h.ep, a.token);
    const sent = await c.call('send_message', { to: ['fake-2'], body: 'hi' });
    await h.host.onSessionDeleted('s2');
    h.sessions.delete('s2');
    const replies: HostToWebview[] = [];
    await h.host.handleRenderer(
      { type: 'mcp:thread:get', requestId: 1, threadId: sent.body.thread_id },
      (m) => replies.push(m),
    );
    const r = replies[0];
    expect(r.type === 'mcp:thread' && r.thread?.messages[0]?.recipients['fake-2']?.status).toBe(
      'undelivered',
    );
  });
});

describe('createConduitMcpHost — notices', () => {
  async function pair(h: Harness) {
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const cb = await ready(h, 's2');
    settle(h);
    return { ca, cb };
  }

  it('idle prompt + quiet + settled + live connection → notice text, the echo, then "\\r"', async () => {
    const h = harness();
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    expect(h.host.uiState().sessions.s2?.gate).toBe('open');
    // Noticed now: the spacing holds the next one, and a re-tick types nothing new.
    await h.host.tick();
    expect(writesTo(h, 's2')).toHaveLength(2);
  });

  it('no echo on screen after the gap → no "\\r", unsent-notice attention', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.echo.delete('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['unsent-notice']);
  });

  it('typed text that renders only after the submit gap (Codex) still gets its Enter', async () => {
    const h = harness({ lagEcho: true });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    expect(h.host.uiState().attention).toEqual([]);
  });

  it('a human keystroke during the echo wait withholds the Enter', async () => {
    const h = harness({ lagEcho: true, duringWait: (host) => host.noteHostInput('s2', 'x') });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['unsent-notice']);
  });

  it('logs the notice lifecycle and gate transitions, once per change', async () => {
    const rec = recordingLog();
    const h = harness({ lagEcho: true, echoSubmit: true, log: rec.log });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'a-private-body' });
    await h.host.tick();
    await h.host.tick();
    const lifecycle = () =>
      rec.entries
        .filter((e) => e.msg.startsWith('notice') && e.data?.sessionId === 's2')
        .map((e) => [e.level, e.msg, e.data]);
    await expect.poll(lifecycle).toEqual([
      ['info', 'notice typed', { sessionId: 's2', handle: 'fake-2' }],
      [
        'info',
        'notice echo',
        { sessionId: 's2', handle: 'fake-2', verdict: 'echoed', waitedMs: ECHO_POLL_MS },
      ],
      ['info', 'notice result', { sessionId: 's2', handle: 'fake-2', outcome: 'submitted' }],
      ['info', 'notice submit confirmed', { sessionId: 's2', handle: 'fake-2', waitedMs: 0 }],
    ]);
    // Precheck and the slot's recheck both read 'open': one line. The per-tick badge pass, which
    // reads 'spacing' afterwards with nothing due, logs nothing.
    expect(rec.of('gate').map((e) => [e.data?.sessionId, e.data?.from, e.data?.to])).toEqual([
      ['s2', null, 'open'],
    ]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('spacing');
    expect(rec.entries.every((e) => e.scope === 'conduit-mcp')).toBe(true);
    expect(JSON.stringify(rec.entries)).not.toContain('a-private-body');
  });

  it('logs an Enter the CLI did not take as unconfirmed', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    // ~40 screen snapshots before the bound: slow on a loaded machine.
    await expect
      .poll(() => rec.of('notice submit unconfirmed').map((e) => [e.level, e.data?.sessionId]), {
        timeout: 15_000,
      })
      .toEqual([['warn', 's2']]);
  });

  it('logs a withheld notice with its reason', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    const { ca } = await pair(h);
    h.echo.delete('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(rec.of('notice echo').map((e) => [e.level, e.data?.verdict])).toEqual([
      ['info', 'no-echo'],
    ]);
    expect(rec.of('notice result').map((e) => e.data?.outcome)).toEqual(['withheld']);
  });

  it('logs MCP connects, disconnects and tool calls by name and caller, never their bodies', async () => {
    const rec = recordingLog();
    const h = harness({ log: rec.log });
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    launch(h, 's2');
    await ca.call('send_message', { to: ['fake-2'], body: 'a-private-body' });
    await ca.call('read_attachment', { message_id: 'nope', attachment_id: 'nope' });
    expect(
      rec.of('mcp connected').map((e) => [e.level, e.data?.sessionId, e.data?.handle]),
    ).toEqual([['info', 's1', 'fake-1']]);
    expect(rec.of('tool call').map((e) => e.data)).toEqual([
      { tool: 'send_message', handle: 'fake-1', ok: true },
      { tool: 'read_attachment', handle: 'fake-1', ok: false, code: expect.any(String) },
    ]);
    ca.sock.destroy();
    await expect
      .poll(() => rec.of('mcp disconnected').map((e) => [e.data?.sessionId, e.data?.handle]))
      .toEqual([['s1', 'fake-1']]);
    expect(JSON.stringify(rec.entries)).not.toContain('a-private-body');
  });

  it('gate closes between precheck and slot (renderer input) → gate-closed, nothing written', async () => {
    const h = harness({ holdGaps: true });
    const { ca } = await pair(h);
    h.echo.delete('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    // A timed message holds the session's writer slot while the notifier prechecks (open).
    const timed = h.writer.submit('s2', 'timed');
    await expect.poll(() => h.gaps.length).toBe(1);
    const tickP = h.host.tick();
    await expect.poll(() => h.host.uiState().sessions.s2?.gate).toBe('open');
    await new Promise((r) => setTimeout(r, 50));
    // The human types after the precheck and before the notice's slot opens.
    h.host.onRendererInput('s2', 'f');
    h.gaps.shift()?.();
    expect(await timed).toBe('submitted');
    await tickP;
    expect(writesTo(h, 's2')).toEqual(['timed', '\r']);
    expect(h.host.uiState().sessions.s2?.gate).toBe('draft');
  });

  it('host-originated input inside the submit gap (add-dir paste) withholds the Enter', async () => {
    const h = harness({ holdGaps: true });
    const { ca } = await pair(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    const tickP = h.host.tick();
    await expect.poll(() => h.gaps.length).toBe(1);
    h.host.noteHostInput('s2', '\x1b[200~/add-dir /x\x1b[201~');
    h.gaps.shift()?.();
    await tickP;
    expect(writesTo(h, 's2')).toEqual([composeNotice(false)]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['unsent-notice']);
  });

  it('blocking screen 15 rows below the cursor → no submit', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.host.onOutput('s2', '\x1b[2J\x1b[1;1Hfake❯ \x1b[17;1HEsc to cancel\x1b[1;7H');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('blocking-prompt');
  });

  it('renderer input "fix the" → no submit until "\\r"', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.host.onRendererInput('s2', 'fix the');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('draft');
    h.host.onRendererInput('s2', '\r');
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it('draft cleared after empty-input + 3 s without input', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.host.onRendererInput('s2', 'x');
    h.host.onRendererInput('s2', '\x7f');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    h.clock.t += 2_999;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    h.clock.t += 1;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it('focus report input does not count as draft', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.host.onRendererInput('s2', '\x1b[I');
    h.host.onRendererInput('s2', '\x1b[O');
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it('busy recipient → nothing written; urgent raises attention once; idle then one notice', async () => {
    const h = harness();
    const { ca } = await pair(h);
    h.busy.add('s2');
    await ca.call('send_message', { to: ['fake-2'], body: 'now', priority: 'urgent' });
    await h.host.tick();
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().attention.map((a) => a.reason)).toEqual(['urgent-waiting']);
    h.busy.delete('s2');
    h.lastOut.set('s2', h.clock.t);
    h.clock.t += 3_000;
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(true), '\r']);
    await expect.poll(() => h.host.uiState().attention.map((a) => a.reason)).toEqual([]);
  });

  it('paused → no submit; badge gate "paused"', async () => {
    const h = harness();
    const { ca } = await pair(h);
    await h.host.handleRenderer(
      { type: 'mcp:pause', sessionId: 's2', paused: true },
      () => undefined,
    );
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2).toMatchObject({ paused: true, gate: 'paused', unread: 1 });
  });

  it('codex session gets a handle and is never typed into while its own prompt is not on screen', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    h.sessions.set('s3', session('s3', { agentId: 'codex' }));
    const c = launch(h, 's3', CODEX, spec('/usr/bin/codex'));
    expect(c.spec.args.filter((x) => x === '-c')).toHaveLength(5);
    await client(h.ep, c.token);
    h.host.onOutput('s3', 'fake❯ ');
    settle(h);
    await ca.call('send_message', { to: ['codex-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's3')).toEqual([]);
    expect(h.host.uiState().sessions.s3).toMatchObject({
      handle: 'codex-1',
      gate: 'no-empty-input',
    });
  });

  it('no live connection → never typed into', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    launch(h, 's2');
    h.host.onOutput('s2', 'fake❯ ');
    h.echo.add('s2');
    settle(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([]);
    expect(h.host.uiState().sessions.s2?.gate).toBe('no-connection');
  });
});

describe('createConduitMcpHost — store', () => {
  function failingIo(): StoreIo & { fail: boolean; loads: number } {
    const io = {
      fail: true,
      loads: 0,
      log: '',
      async readLog() {
        io.loads += 1;
        if (io.fail) throw new Error('disk gone');
        return io.log || undefined;
      },
      async appendLog(line: string) {
        io.log += line;
      },
      async rewriteLog(text: string) {
        io.log = text;
      },
      async writeBlob() {},
      async readBlob() {
        return undefined;
      },
      async deleteBlob() {},
      async listBlobs() {
        return [];
      },
      async sweepPartialBlobs() {},
    };
    return io;
  }

  it('store load failure → storeError and store_unavailable; mcp:retry reloads; retry while available does not', async () => {
    const io = failingIo();
    const h = harness({ storeIo: io });
    await h.host.start();
    expect(h.host.uiState()).toMatchObject({ loading: false });
    expect(h.host.uiState().storeError).toContain('disk gone');
    const a = launch(h, 's1');
    const c = await client(h.ep, a.token);
    expect((await c.call('list_sessions')).body.error.code).toBe('store_unavailable');
    io.fail = false;
    await h.host.handleRenderer({ type: 'mcp:retry' }, () => undefined);
    expect(io.loads).toBe(2);
    expect(h.host.uiState().storeError).toBeNull();
    await h.host.handleRenderer({ type: 'mcp:retry' }, () => undefined);
    expect(io.loads).toBe(2);
  });

  it('restart: a new host over the same dir re-arms a noticed unread message', async () => {
    const h = harness();
    const a = await (async () => {
      await h.host.start();
      const x = launch(h, 's1');
      return client(h.ep, x.token);
    })();
    const cb = await ready(h, 's2');
    settle(h);
    await a.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
    cb.sock.destroy();
    await h.host.stop();

    const h2 = harness({ dir: h.dir });
    for (const id of ['s1', 's2']) h2.sessions.set(id, { ...(h.sessions.get(id) as Session) });
    await h2.host.start();
    launch(h2, 's1');
    await ready(h2, 's2');
    settle(h2);
    h2.clock.t += 30_000;
    await h2.host.tick();
    expect(writesTo(h2, 's2')).toEqual([composeNotice(false), '\r']);
  });
});

describe('a launch waits for the endpoint (conductor decision: restored sessions get messaging)', () => {
  it('a launch that awaits whenLaunchReady while start() is still listening is wired', async () => {
    const h = harness();
    h.sessions.set('s1', session('s1'));
    const started = h.host.start();
    const t0 = Date.now();
    await h.host.whenLaunchReady(FAKE);
    // Released by the listen itself, not by the bound.
    expect(Date.now() - t0).toBeLessThan(ENDPOINT_READY_WAIT_MS);
    const out = h.host.prepareLaunch('s1', FAKE, spec());
    expect(out.env?.CONDUIT_SESSION_TOKEN).toBeDefined();
    expect(h.host.uiState().sessions.s1?.unavailable).toBeNull();
    await started;
  });

  it('the wait is bounded at 3 s, then the launch reads endpoint-down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness({
        createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
      });
      h.sessions.set('s1', session('s1'));
      void h.host.start();
      let done = false;
      const waited = h.host.whenLaunchReady(FAKE).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(ENDPOINT_READY_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waited;
      expect(ENDPOINT_READY_WAIT_MS).toBe(3_000);
      const sp = spec();
      expect(h.host.prepareLaunch('s1', FAKE, sp)).toBe(sp);
      expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed listen ends the wait at once', async () => {
    const h = harness({
      createEndpoint: () => ({
        listen: async () => ({ ok: false, error: toolError('host_unavailable', 'EADDRINUSE') }),
        close: async () => {},
      }),
    });
    h.sessions.set('s1', session('s1'));
    const started = h.host.start();
    const t0 = Date.now();
    await h.host.whenLaunchReady(FAKE);
    expect(Date.now() - t0).toBeLessThan(ENDPOINT_READY_WAIT_MS);
    const sp = spec();
    expect(h.host.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    await started;
  });

  it('a listen that throws ends the wait at once, and start() still finishes', async () => {
    const h = harness({
      createEndpoint: () => ({
        listen: async () => {
          throw new Error('EACCES');
        },
        close: async () => {},
      }),
    });
    h.sessions.set('s1', session('s1'));
    const started = h.host.start().then(
      () => 'resolved',
      (err: unknown) => `rejected: ${String(err)}`,
    );
    const t0 = Date.now();
    await h.host.whenLaunchReady(FAKE);
    expect(Date.now() - t0).toBeLessThan(ENDPOINT_READY_WAIT_MS);
    const sp = spec();
    expect(h.host.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    expect(await started).toBe('resolved');
  });

  it('an agent without an adapter never waits', async () => {
    const h = harness({
      createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
    });
    void h.host.start();
    let done = false;
    await Promise.race([
      h.host.whenLaunchReady(SHELL).then(() => {
        done = true;
      }),
      new Promise((r) => setTimeout(r, 50)),
    ]);
    expect(done).toBe(true);
  });
});
