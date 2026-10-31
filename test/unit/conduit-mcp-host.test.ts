import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpEndpoint } from '../../electron/conduit-mcp-endpoint';
import {
  type ConduitMcpHost,
  type ConduitMcpHostDeps,
  createConduitMcpHost,
  ENDPOINT_READY_WAIT_MS,
} from '../../electron/conduit-mcp-host';
import { createSessionScreens, type SessionScreens } from '../../electron/session-screens';
import { MCP_ADAPTERS } from '../../src/conduit-mcp/adapters';
import type { McpFileRequest, McpOpenRequest, PathKind } from '../../src/conduit-mcp/control-tools';
import { ECHO_POLL_MS } from '../../src/conduit-mcp/notice-gate';
import { composeNotice } from '../../src/conduit-mcp/notice-text';
import { screenVerdict } from '../../src/conduit-mcp/screen-verdict';
import type { StoreIo } from '../../src/conduit-mcp/store';
import {
  DEFAULT_MCP_TOOLS,
  type McpToolSwitches,
  TOOL_NAMES,
  withOverride,
} from '../../src/conduit-mcp/tool-switches';
import { toolError } from '../../src/conduit-mcp/types';
import type { HostToWebview } from '../../src/protocol';
import { createPtyWriter } from '../../src/pty-writer';
import { COMMAND_AGENT_ID, commandDef } from '../../src/session-command';
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
/** Measured (runtime QA 2026-10-27, F1): a relaunched cmd.exe shell's bytes around Claude's initialize. */
const CLAUDE_BEFORE_INIT: {
  cols: number;
  rows: number;
  beforeInitialize: string;
  afterInitialize: string;
} = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'conduit-mcp', 'claude-box-before-initialize.json'),
    'utf8',
  ),
);
const CODEX: AgentDefinition = { ...FAKE, id: 'codex', command: '/usr/bin/codex' };
const CURSOR: AgentDefinition = { ...FAKE, id: 'cursor', command: '/usr/bin/agent' };
const CLAUDE: AgentDefinition = { ...FAKE, id: 'claude', command: '/usr/bin/claude' };
const DEFS = [FAKE, SHELL, CODEX, CURSOR, CLAUDE];
const defOfSession = (s: Session | undefined): AgentDefinition | undefined =>
  s?.agentId === COMMAND_AGENT_ID
    ? s.command && commandDef(s.command)
    : DEFS.find((d) => d.id === s?.agentId);
const spec = (command = '/usr/bin/node'): SpawnSpec => ({
  command,
  args: ['fake.mjs'],
  cwd: '/w',
  env: { A: '1' },
});

/** The harness's detection grace; the host default (DETECT_GRACE_MS) is main's. */
const GRACE = 1_000;

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
  /** Every control open/file request the host handed to main. */
  opens: McpOpenRequest[];
  files: McpFileRequest[];
  screens: SessionScreens;
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
    mcpTools?: () => McpToolSwitches;
    kinds?: Record<string, PathKind>;
    /** Records every line the host sends into `calls`, so ordering against setMcp is visible. */
    recordSends?: boolean;
    installState?: ConduitMcpHostDeps['installState'];
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
  const opens: McpOpenRequest[] = [];
  const files: McpFileRequest[] = [];
  const lagged: Array<[string, string]> = [];
  const screens = createSessionScreens();
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
      setMcpToolOverride: (id, tool, value) => {
        const s = sessions.get(id);
        if (!s) return false;
        const next = withOverride(s.mcpToolOverrides, tool, value);
        if (next) s.mcpToolOverrides = next;
        else delete s.mcpToolOverrides;
        return true;
      },
    },
    mcpTools: opts.mcpTools ?? (() => DEFAULT_MCP_TOOLS),
    installState: opts.installState ?? (() => 'not-installed'),
    detectGraceMs: GRACE,
    defOf: (id) => defOfSession(sessions.get(id)),
    agentIds: () => DEFS.map((d) => d.id),
    control: {
      homeOf: (id) => sessions.get(id)?.home,
      resolvePath: (h, rel) => (rel.startsWith('/') ? rel : `${h}/${rel}`),
      kindOf: async (abs) => opts.kinds?.[abs] ?? 'missing',
      resolveCommand: (c) => `/usr/bin/${c}`,
      // Stands in for main's createMcpSession: the session exists, unlaunched and unhandled.
      openSession: async (req) => {
        const id = `n${opens.length + 1}`;
        opens.push(req);
        sessions.set(
          id,
          session(id, {
            agentId: req.launch.kind === 'agent' ? req.launch.agentId : COMMAND_AGENT_ID,
            home: req.home,
            ...(req.launch.kind === 'command' ? { command: req.launch.command } : {}),
          }),
        );
        return { ok: true, sessionId: id, label: `S ${id}` };
      },
      openFile: async (req) => {
        files.push(req);
        return { sessionId: req.callerSessionId };
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
    screens,
    listen: opts.listen ?? true,
    tickMs: opts.tickMs ?? 0,
    createEndpoint:
      opts.createEndpoint ??
      (opts.recordSends
        ? (o) =>
            createMcpEndpoint({
              ...o,
              onConnection: (conn) =>
                o.onConnection({
                  id: conn.id,
                  token: conn.token,
                  send: (line) => {
                    calls.push(`send ${line}`);
                    conn.send(line);
                  },
                  onLine: (cb) => conn.onLine(cb),
                  onClose: (cb) => conn.onClose(cb),
                  close: () => conn.close(),
                }),
            })
        : undefined),
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
    opens,
    files,
    screens,
  };
}

/** A minimal JSON-RPC client over the endpoint, as the shim + CLI would be. */
async function client(ep: string, token: string | null, clientName?: string) {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(ep, () => resolve(s));
    s.on('error', reject);
  });
  sockets.push(sock);
  sock.setEncoding('utf8');
  let buf = '';
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  const notifications: string[] = [];
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      if (msg.id === undefined && typeof msg.method === 'string') notifications.push(msg.method);
      else waiting.get(msg.id as number)?.(msg);
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
  await request('initialize', {
    protocolVersion: '2025-06-18',
    ...(clientName === undefined ? {} : { clientInfo: { name: clientName, version: '1' } }),
  });
  const call = async (name: string, args: unknown = {}) => {
    const r = (await request('tools/call', { name, arguments: args })) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    return { isError: r.result.isError === true, body: JSON.parse(r.result.content[0].text) };
  };
  const listed = async () => {
    const r = (await request('tools/list')) as { result: { tools: Array<{ name: string }> } };
    return r.result.tools.map((t) => t.name);
  };
  return { request, call, sock, notifications, listed };
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
  const notifications: string[] = [];
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      if (msg.id === undefined && typeof msg.method === 'string') notifications.push(msg.method);
      else waiting.get(msg.id as number)?.(msg);
      i = buf.indexOf('\n');
    }
  });
  sock.write(`${JSON.stringify({ conduit: 1, token })}\n`);
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(id, resolve);
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { request, closed, notifications };
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

  it('AC1 a plain shell gets token + endpoint and no handle', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1', { agentId: 'pwsh' }));
    const sp = spec('/usr/bin/pwsh');
    const out = h.host.prepareLaunch('s1', SHELL, sp);
    expect(out.env).toEqual({ A: '1', CONDUIT_SESSION_TOKEN: 'tok1', CONDUIT_MCP_ENDPOINT: h.ep });
    expect(out.args).toEqual(sp.args);
    expect(out.command).toBe(sp.command);
    expect(h.sessions.get('s1')?.mcpHandle).toBeUndefined();
    expect(fs.existsSync(path.join(h.dir, 'launch', 's1.json'))).toBe(false);
    expect(h.host.uiState().sessions).toEqual({});
  });

  it('AC1 messaging off or endpoint down: a shell gets nothing, uiState shows nothing', async () => {
    let on = false;
    const h = harness({ messagingOn: () => on });
    h.sessions.set('s1', session('s1', { agentId: 'pwsh' }));
    const sp = spec('/usr/bin/pwsh');
    on = true;
    expect(h.host.prepareLaunch('s1', SHELL, sp)).toBe(sp);
    await h.host.start();
    on = false;
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

  it('list_sessions omits a session that has no handle', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    h.sessions.set('s2', session('s2'));
    h.alive.add('s2');
    const c = await client(h.ep, a.token);
    const sessions: unknown[] = (await c.call('list_sessions')).body.sessions;
    expect(h.sessions.get('s2')?.mcpHandle).toBeUndefined();
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain('S s2');
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

  it('claude session whose input row holds only a dim suggested prompt gets its notice', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    h.sessions.set('s4', session('s4', { agentId: 'claude' }));
    const c = launch(h, 's4', CLAUDE, spec('/usr/bin/claude'));
    await client(h.ep, c.token);
    // Claude 2.1.310 after a turn: bare prompt, a faint suggestion, cursor parked before it.
    h.host.onOutput('s4', '❯ \x1b[2myes, go ahead\x1b[22m\x1b[3G');
    h.echo.add('s4');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's4')).toEqual([composeNotice(false), '\r']);
  });

  it('claude session with typed (normal-weight) text on the input row is not typed into', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    h.sessions.set('s4', session('s4', { agentId: 'claude' }));
    const c = launch(h, 's4', CLAUDE, spec('/usr/bin/claude'));
    await client(h.ep, c.token);
    h.host.onOutput('s4', '❯ yes, go ahead');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's4')).toEqual([]);
    expect(h.host.uiState().sessions.s4?.gate).toBe('no-empty-input');
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

describe('createConduitMcpHost — store', () => {
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
    await h.host.whenLaunchReady();
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
      const waited = h.host.whenLaunchReady().then(() => {
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
    await h.host.whenLaunchReady();
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
    await h.host.whenLaunchReady();
    expect(Date.now() - t0).toBeLessThan(ENDPOINT_READY_WAIT_MS);
    const sp = spec();
    expect(h.host.prepareLaunch('s1', FAKE, sp)).toBe(sp);
    expect(h.host.uiState().sessions.s1?.unavailable).toBe('endpoint-down');
    expect(await started).toBe('resolved');
  });

  it('B1 a shell restored at start waits too, and is wired once the endpoint listens', async () => {
    const h = harness();
    h.sessions.set('sh', session('sh', { agentId: 'pwsh' }));
    let done = false;
    const waited = h.host.whenLaunchReady().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    const started = h.host.start();
    await waited;
    const out = h.host.prepareLaunch('sh', SHELL, spec('/usr/bin/pwsh'));
    expect(out.env?.CONDUIT_SESSION_TOKEN).toBeDefined();
    await started;
  });

  it('B1 the shell wait is bounded at 3 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness({
        createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
      });
      void h.host.start();
      let done = false;
      const waited = h.host.whenLaunchReady().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(ENDPOINT_READY_WAIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waited;
    } finally {
      vi.useRealTimers();
    }
  });

  it('with messaging off nothing waits', async () => {
    const h = harness({
      messagingOn: () => false,
      createEndpoint: () => ({ listen: () => new Promise(() => {}), close: async () => {} }),
    });
    void h.host.start();
    let done = 0;
    await Promise.race([
      Promise.all([h.host.whenLaunchReady(), h.host.whenLaunchReady()]).then(() => {
        done = 2;
      }),
      new Promise((r) => setTimeout(r, 50)),
    ]);
    expect(done).toBe(2);
  });
});

describe('control tools: gate, effective tool list, list_changed, overrides (spec 2026-10-27 §2, §3.4)', () => {
  const MESSAGING = ['list_sessions', 'send_message', 'read_inbox', 'read_attachment'];
  const overrideOf = (h: Harness, id: string, o: Session['mcpToolOverrides']) => {
    const s = h.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    s.mcpToolOverrides = o;
  };
  const settleNotes = () => new Promise((r) => setTimeout(r, 30));

  it('master off → messaging_off for open_session and send_message; tools/list lists all 7', async () => {
    // A launch with the master off is unwired, so this is a CLI started before it was turned off.
    let on = true;
    const h = harness({ messagingOn: () => on });
    await h.host.start();
    const a = launch(h, 's1');
    const c = await client(h.ep, a.token);
    on = false;
    expect(await c.listed()).toEqual([...TOOL_NAMES]);
    expect(
      (await c.call('open_session', { path: '/w', agent: 'e2e-fake-mcp' })).body.error.code,
    ).toBe('messaging_off');
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'messaging_off',
    );
  });

  it('master on, control default → open_session tool_disabled; list excludes control tools', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const c = await client(h.ep, a.token);
    expect(await c.listed()).toEqual(MESSAGING);
    const r = await c.call('open_session', { path: '/w', agent: 'e2e-fake-mcp' });
    expect(r.body.error.code).toBe('tool_disabled');
  });

  it('tool_disabled precedes store_unavailable', async () => {
    const h = harness({ storeIo: failingIo() });
    await h.host.start();
    const a = launch(h, 's1');
    const c = await client(h.ep, a.token);
    overrideOf(h, 's1', { send_message: false });
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'tool_disabled',
    );
    overrideOf(h, 's1', { send_message: true });
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'store_unavailable',
    );
  });

  it('override true for one session lists open_session only on that connection', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const b = launch(h, 's2');
    overrideOf(h, 's1', { open_session: true });
    const ca = await client(h.ep, a.token);
    const cb = await client(h.ep, b.token);
    expect(await ca.listed()).toEqual([...MESSAGING, 'open_session']);
    expect(await cb.listed()).toEqual(MESSAGING);
  });

  it('override change sends list_changed once to an initialized connection, not an uninitialized one, not again when unchanged', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const c = await client(h.ep, a.token);
    await c.listed();
    const raw = await helloOnly(h.ep, a.token);
    await raw.request(1, 'tools/list');
    const set = async (value: boolean | 'inherit') => {
      const replies: HostToWebview[] = [];
      await h.host.handleRenderer(
        { type: 'mcp:setToolOverride', requestId: 1, sessionId: 's1', tool: 'open_session', value },
        (m) => replies.push(m),
      );
      return replies;
    };
    await set(true);
    await settleNotes();
    expect(c.notifications).toEqual(['notifications/tools/list_changed']);
    await set(true);
    await settleNotes();
    expect(c.notifications).toHaveLength(1);
    await set('inherit');
    await settleNotes();
    expect(c.notifications).toHaveLength(2);
    expect(raw.notifications).toEqual([]);
  });

  it('settings change via refresh() sends list_changed to affected connections only', async () => {
    let tools: McpToolSwitches = { ...DEFAULT_MCP_TOOLS };
    const h = harness({ mcpTools: () => tools });
    await h.host.start();
    const a = launch(h, 's1');
    const b = launch(h, 's2');
    overrideOf(h, 's2', { open_file: false });
    const ca = await client(h.ep, a.token);
    const cb = await client(h.ep, b.token);
    await ca.listed();
    await cb.listed();
    tools = { ...tools, open_file: true };
    h.host.refresh();
    await settleNotes();
    expect(ca.notifications).toEqual(['notifications/tools/list_changed']);
    expect(cb.notifications).toEqual([]);
    expect(await ca.listed()).toEqual([...MESSAGING, 'open_file']);
  });

  it('mcp:setToolOverride replies unknown-session / unknown-tool / invalid-value / ok', async () => {
    const h = harness();
    await h.host.start();
    h.sessions.set('s1', session('s1'));
    const ask = async (m: { sessionId: string; tool: string; value: unknown }) => {
      const replies: HostToWebview[] = [];
      await h.host.handleRenderer(
        {
          type: 'mcp:setToolOverride',
          requestId: 9,
          sessionId: m.sessionId,
          tool: m.tool,
          value: m.value as boolean,
        },
        (r) => replies.push(r),
      );
      return replies;
    };
    expect(await ask({ sessionId: 'nope', tool: 'open_file', value: true })).toEqual([
      { type: 'mcp:toolOverrideResult', requestId: 9, ok: false, error: 'unknown-session' },
    ]);
    expect(await ask({ sessionId: 's1', tool: 'rm_rf', value: true })).toEqual([
      { type: 'mcp:toolOverrideResult', requestId: 9, ok: false, error: 'unknown-tool' },
    ]);
    expect(await ask({ sessionId: 's1', tool: 'open_file', value: 'yes' })).toEqual([
      { type: 'mcp:toolOverrideResult', requestId: 9, ok: false, error: 'invalid-value' },
    ]);
    expect(h.sessions.get('s1')?.mcpToolOverrides).toBeUndefined();
    expect(await ask({ sessionId: 's1', tool: 'open_file', value: true })).toEqual([
      { type: 'mcp:toolOverrideResult', requestId: 9, ok: true },
    ]);
    expect(h.sessions.get('s1')?.mcpToolOverrides).toEqual({ open_file: true });
  });

  it('uiState.switchable lists sessions whose defOf matches an adapter, before any launch', () => {
    const h = harness();
    h.sessions.set('fake', session('fake'));
    h.sessions.set('shell', session('shell', { agentId: 'pwsh' }));
    h.sessions.set('gone', session('gone', { agentId: 'removed-profile' }));
    h.sessions.set('claude', session('claude', { agentId: 'claude' }));
    h.sessions.set(
      'cmd-codex',
      session('cmd-codex', {
        agentId: COMMAND_AGENT_ID,
        command: { command: '/usr/bin/codex', args: [] },
      }),
    );
    h.sessions.set(
      'cmd-node',
      session('cmd-node', { agentId: COMMAND_AGENT_ID, command: { command: 'node', args: [] } }),
    );
    expect(h.host.uiState().switchable).toEqual(['fake', 'claude', 'cmd-codex']);
  });
});

describe('control tools live: claimHandle at create, routing (spec 2026-10-27 §3.1)', () => {
  const on = (h: Harness, id: string, o: Session['mcpToolOverrides']) => {
    const s = h.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    s.mcpToolOverrides = o;
  };

  it('open_session with the switch on calls control.openSession and returns the claimed handle', async () => {
    const h = harness({ kinds: { '/w/wt': 'dir' } });
    await h.host.start();
    const a = launch(h, 's1');
    on(h, 's1', { open_session: true });
    const c = await client(h.ep, a.token);
    const r = await c.call('open_session', { path: 'wt', agent: 'e2e-fake-mcp', focus: false });
    expect(r.isError).toBe(false);
    expect(r.body).toEqual({
      session_id: 'n1',
      handle: 'fake-2',
      label: 'S n1',
      agent: 'e2e-fake-mcp',
    });
    expect(h.opens).toEqual([
      {
        callerSessionId: 's1',
        openedBy: { handle: 'fake-1', sessionId: 's1' },
        home: '/w/wt',
        label: undefined,
        focus: false,
        launch: { kind: 'agent', agentId: 'e2e-fake-mcp' },
      },
    ]);
    expect(h.sessions.get('n1')?.mcpHandle).toBe('fake-2');
  });

  it('claimHandle at create: a later prepareLaunch keeps the same handle', async () => {
    const h = harness({ kinds: { '/w/wt': 'dir' } });
    await h.host.start();
    const a = launch(h, 's1');
    on(h, 's1', { open_session: true });
    const c = await client(h.ep, a.token);
    await c.call('open_session', { path: 'wt', agent: 'e2e-fake-mcp' });
    const handles = fs.readFileSync(path.join(h.dir, 'handles.json'), 'utf8');
    launch(h, 'n1');
    expect(h.sessions.get('n1')?.mcpHandle).toBe('fake-2');
    expect(fs.readFileSync(path.join(h.dir, 'handles.json'), 'utf8')).toBe(handles);
  });

  it('open_terminal: a command with no adapter gets no handle', async () => {
    const h = harness({ kinds: { '/w': 'dir' } });
    await h.host.start();
    const a = launch(h, 's1');
    on(h, 's1', { open_terminal: true });
    const c = await client(h.ep, a.token);
    const r = await c.call('open_terminal', { path: '/w', command: 'node', args: ['-e', 'x'] });
    expect(r.body).toMatchObject({ session_id: 'n1', handle: null, agent: 'node' });
    expect(h.sessions.get('n1')?.mcpHandle).toBeUndefined();
  });

  it('open_terminal: a command whose leaf matches an adapter gets a handle at create and MCP wiring at launch', async () => {
    const h = harness({ kinds: { '/w': 'dir' } });
    await h.host.start();
    const a = launch(h, 's1');
    on(h, 's1', { open_terminal: true });
    const c = await client(h.ep, a.token);
    const r = await c.call('open_terminal', { path: '/w', command: '/opt/bin/claude' });
    expect(r.body).toMatchObject({ session_id: 'n1', handle: 'claude-1', agent: 'claude' });
    const n1 = h.sessions.get('n1');
    if (!n1?.command) throw new Error('n1 has no command');
    const out = launch(h, 'n1', commandDef(n1.command), spec('/opt/bin/claude'));
    expect(out.token).toEqual(expect.any(String));
    expect(h.sessions.get('n1')?.mcpHandle).toBe('claude-1');
  });

  it('handles.json write failure → handle null, unavailable launch-io', async () => {
    const rec = recordingLog();
    const h = harness({ kinds: { '/w/wt': 'dir' }, log: rec.log });
    await h.host.start();
    const a = launch(h, 's1');
    on(h, 's1', { open_session: true });
    const c = await client(h.ep, a.token);
    fs.rmSync(path.join(h.dir, 'handles.json'));
    fs.mkdirSync(path.join(h.dir, 'handles.json'));
    const r = await c.call('open_session', { path: 'wt', agent: 'e2e-fake-mcp' });
    expect(r.body).toMatchObject({ session_id: 'n1', handle: null });
    expect(h.sessions.get('n1')?.mcpHandle).toBeUndefined();
    expect(rec.of('handles.json write failed')).toHaveLength(1);
  });

  it('open_file routes to control.openFile', async () => {
    const h = harness({ kinds: { '/w/src/a.ts': 'file' } });
    await h.host.start();
    const a = launch(h, 's1');
    on(h, 's1', { open_file: true });
    const c = await client(h.ep, a.token);
    const r = await c.call('open_file', { path: 'src/a.ts', line: 3 });
    expect(r.body).toEqual({ opened: '/w/src/a.ts', session_id: 's1' });
    expect(h.files).toEqual([
      { callerSessionId: 's1', path: '/w/src/a.ts', line: 3, column: undefined, focus: true },
    ]);
  });

  it('a control tool with the store down is not store_unavailable', async () => {
    const h = harness({ kinds: { '/w/src/a.ts': 'file' }, storeIo: failingIo() });
    await h.host.start();
    const a = launch(h, 's1');
    on(h, 's1', { open_file: true });
    const c = await client(h.ep, a.token);
    expect((await c.call('send_message', { to: ['x'], body: 'b' })).body.error.code).toBe(
      'store_unavailable',
    );
    const r = await c.call('open_file', { path: 'src/a.ts' });
    expect(r.isError).toBe(false);
  });
});

describe('lazy identity: token for every session, handle from clientInfo (spec 2026-10-27-conduit-mcp-install §3.1, §3.3)', () => {
  const shell = (h: Harness, id: string) => launch(h, id, SHELL, spec('/usr/bin/pwsh'));
  const handlesOf = (body: { sessions: Array<{ handle: string; agent: string }> }) =>
    body.sessions.map((s) => [s.handle, s.agent]);

  it('AC2 first initialize from claude-code allocates claude-<n> before the reply', async () => {
    const h = harness({ recordSends: true });
    await h.host.start();
    const { token } = shell(h, 'sh1');
    const c = await helloOnly(h.ep, token);
    await c.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'claude-code', version: '2.1.312' },
    });
    const setAt = h.calls.findIndex((x) => x.startsWith('setMcp {"mcpHandle":"claude-1"}'));
    const replyAt = h.calls.findIndex((x) => x.startsWith('send ') && x.includes('"serverInfo"'));
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(replyAt).toBeGreaterThan(setAt);
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'handles.json'), 'utf8'))).toEqual({
      claude: 1,
    });
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).toBe(true);
  });

  it('a server/discover request before initialize is answered -32601 and initialize still connects', async () => {
    const h = harness();
    await h.host.start();
    const { token } = shell(h, 'sh1');
    const c = await helloOnly(h.ep, token);
    const discover = (await c.request(1, 'server/discover', {})) as {
      error?: { code: number };
    };
    expect(discover.error?.code).toBe(-32601);
    expect(h.sessions.get('sh1')?.mcpHandle).toBeUndefined();
    const init = (await c.request(2, 'initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'claude-code', version: '2.1.312' },
    })) as { result?: { serverInfo: { name: string } } };
    expect(init.result?.serverInfo.name).toBe('conduit');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).toBe(true);
  });

  it('AC2 unknown client → agent-<n>; a missing clientInfo too', async () => {
    const h = harness();
    await h.host.start();
    await client(h.ep, shell(h, 'sh1').token, 'some-ide');
    await client(h.ep, shell(h, 'sh2').token);
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('agent-1');
    expect(h.sessions.get('sh2')?.mcpHandle).toBe('agent-2');
  });

  it('AC2 second CLI in the same shell keeps the handle', async () => {
    const h = harness();
    await h.host.start();
    const { token } = shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    await client(h.ep, token, 'codex-mcp-client');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    expect(h.calls.filter((c) => c.startsWith('setMcp'))).toHaveLength(1);
  });

  it('AC2 the lazily named session is in list_sessions with agent = live kind, else prefix', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const { token } = shell(h, 'sh1');
    const claude = await client(h.ep, token, 'claude-code');
    const codex = await client(h.ep, token, 'codex-mcp-client');
    const list = async () => handlesOf((await ca.call('list_sessions')).body);
    await expect.poll(list).toEqual([
      ['fake-1', 'fake'],
      ['claude-1', 'codex'],
    ]);
    // Message history keeps a lazy session listed after its CLIs leave (amendment B2).
    expect((await ca.call('send_message', { to: ['claude-1'], body: 'hi' })).isError).toBe(false);
    codex.sock.destroy();
    await expect.poll(list).toEqual([
      ['fake-1', 'fake'],
      ['claude-1', 'claude'],
    ]);
    claude.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).not.toBe(true);
    expect(await list()).toEqual([
      ['fake-1', 'fake'],
      ['claude-1', 'claude'],
    ]);
  });

  it('B2 a health check does not enrol a shell: after it closes the session is absent', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    const ca = await client(h.ep, a.token);
    const check = await client(h.ep, shell(h, 'sh1').token, 'claude-code');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    await expect.poll(() => Object.keys(h.host.uiState().sessions).sort()).toEqual(['s1', 'sh1']);
    check.sock.destroy();
    await expect
      .poll(async () => handlesOf((await ca.call('list_sessions')).body))
      .toEqual([['fake-1', 'fake']]);
    expect(Object.keys(h.host.uiState().sessions)).toEqual(['s1']);
    expect((await ca.call('send_message', { to: ['claude-1'], body: 'x' })).body.error.code).toBe(
      'unknown_handle',
    );
  });

  it('an adapter session stays listed without a connection', async () => {
    const h = harness();
    await h.host.start();
    const a = launch(h, 's1');
    launch(h, 's2');
    const ca = await client(h.ep, a.token);
    expect(handlesOf((await ca.call('list_sessions')).body).map(([x]) => x)).toEqual([
      'fake-1',
      'fake-2',
    ]);
  });

  it('a forged token initialize allocates nothing', async () => {
    const h = harness();
    await h.host.start();
    shell(h, 'sh1');
    const c = await client(h.ep, 'forged', 'claude-code');
    expect(await c.listed()).toEqual([]);
    expect(h.sessions.get('sh1')?.mcpHandle).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('N5 a failed lazy claim is cleared by the next launch', async () => {
    const h = harness();
    await h.host.start();
    fs.mkdirSync(path.join(h.dir, 'handles.json'));
    await client(h.ep, shell(h, 'sh1').token, 'claude-code');
    expect(h.sessions.get('sh1')?.mcpHandle).toBeUndefined();
    fs.rmSync(path.join(h.dir, 'handles.json'), { recursive: true });
    const { token } = shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    expect(h.sessions.get('sh1')?.mcpHandle).toBe('claude-1');
    await expect.poll(() => h.host.uiState().sessions.sh1?.unavailable).toBeNull();
  });

  it('S1 switchable includes a shell once it has a handle', async () => {
    const h = harness();
    await h.host.start();
    const { token } = shell(h, 'sh1');
    expect(h.host.uiState().switchable).toEqual([]);
    const c = await client(h.ep, token, 'claude-code');
    expect(h.host.uiState().switchable).toEqual(['sh1']);
    // B2 hides it once the health check closes; its menu item goes with the badge.
    c.sock.destroy();
    await expect.poll(() => h.host.uiState().switchable).toEqual([]);
  });
});

describe('notice adapter from the live client (spec 2026-10-27-conduit-mcp-install §2.4, D6)', () => {
  const shell = (h: Harness, id: string) => launch(h, id, SHELL, spec('/usr/bin/pwsh'));
  async function sender(h: Harness) {
    await h.host.start();
    const a = launch(h, 's1');
    return client(h.ep, a.token);
  }

  /** `❯ ` is Claude's empty input row, and just as much a starship/pure shell prompt. */
  function idlePrompt(h: Harness, id: string) {
    h.host.onOutput(id, '❯ ');
    h.echo.add(id);
  }
  /** Claude's ruled input box at `launch`'s 40 cols: a rule, the `❯ ` row holding the cursor, a rule. */
  function claudeBox(h: Harness, id: string) {
    const rule = '─'.repeat(40);
    h.host.onOutput(id, `${rule}\r\n❯ \r\n${rule}\x1b[1A\r\x1b[2C`);
    h.echo.add(id);
  }

  it('AC3 `claude` typed, then claude-code connects → claude notices', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  it('F1 Claude paints its box before initialize: the lazy model is seeded from the output tail', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onResize('sh1', CLAUDE_BEFORE_INIT.cols, CLAUDE_BEFORE_INIT.rows);
    h.host.onRendererInput('sh1', 'claude --model haiku\r');
    h.host.onOutput('sh1', CLAUDE_BEFORE_INIT.beforeInitialize);
    await client(h.ep, token, 'claude-code');
    h.host.onOutput('sh1', CLAUDE_BEFORE_INIT.afterInitialize);
    const snap = await h.screens.snapshot('sh1');
    const claude = MCP_ADAPTERS.find((a) => a.id === 'claude');
    expect(snap && claude && screenVerdict(claude.screen, snap)).toBe('empty-input');
    expect(snap?.lines[(snap?.cursorY ?? 0) - 1]).toMatch(/^─{100,}$/);
    h.echo.add('sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  /** The first row of a model started now: what the session's output tail seeds it with. */
  async function seededRow(h: Harness, id: string) {
    h.screens.start(id, 40, 24);
    return (await h.screens.snapshot(id))?.lines[0];
  }

  it('S6 a shell keeps an output tail only while messaging is on', async () => {
    for (const [on, row] of [
      [true, 'before'],
      [false, ''],
    ] as const) {
      const h = harness({ messagingOn: () => on });
      await h.host.start();
      shell(h, 'sh1');
      h.host.onOutput('sh1', 'before');
      expect(await seededRow(h, 'sh1')).toBe(row);
    }
  });

  it('S6 a profile session keeps no tail: its model starts at spawn', async () => {
    const h = harness();
    await h.host.start();
    const keepTail = vi.spyOn(h.screens, 'keepTail');
    launch(h, 'c1', CLAUDE);
    expect(keepTail).not.toHaveBeenCalled();
    expect(h.screens.has('c1')).toBe(true);
    shell(h, 'sh1');
    expect(keepTail).toHaveBeenCalledWith('sh1', 40, 24);
  });

  it('S6 exit and delete drop the tail; a relaunch keeps only the new generation', async () => {
    const h = harness();
    await h.host.start();
    shell(h, 'ex');
    h.host.onOutput('ex', 'old');
    h.host.onExit('ex');
    expect(await seededRow(h, 'ex')).toBe('');

    shell(h, 'del');
    h.host.onOutput('del', 'old');
    await h.host.onSessionDeleted('del');
    expect(await seededRow(h, 'del')).toBe('');

    shell(h, 're');
    h.host.onOutput('re', 'old');
    shell(h, 're');
    h.host.onOutput('re', 'new');
    expect(await seededRow(h, 're')).toBe('new');
  });

  for (const [what, keys] of [
    ['Down+Enter in its trust dialog', '\x1b[B\r'],
    ['a bare Enter', '\r'],
  ] as const) {
    it(`F6 \`claude\`, then ${what} before initialize → still bound`, async () => {
      const h = harness();
      const ca = await sender(h);
      const { token } = shell(h, 'sh1');
      h.host.onRendererInput('sh1', 'claude\r');
      h.host.onRendererInput('sh1', keys);
      await client(h.ep, token, 'claude-code');
      claudeBox(h, 'sh1');
      settle(h);
      await ca.call('send_message', { to: ['claude-1'], body: 'see' });
      await h.host.tick();
      expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
    });
  }

  it('D-F6 `claude`, an untyped Enter 30 s later, then the client → bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    h.clock.t += 30_000;
    h.host.onRendererInput('sh1', '\x1b[B\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  // History recall (Up, Enter) is untyped too, and may re-run `code .` (review S1).
  it('D-F6 `claude`, an untyped Enter 90 s later → a later client is not bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    h.clock.t += 90_000;
    h.host.onRendererInput('sh1', '\x1b[A\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('F6 `claude`, then `ls` → a later client is not bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    h.host.onRendererInput('sh1', 'ls\r');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: `code .` typed, then a claude-code client connects → nothing typed at the shell prompt', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'code .\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: no line typed at all → pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    await client(h.ep, shell(h, 'sh1').token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: `claude`, connect, a prompt typed into it → still bound', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    h.host.onRendererInput('sh1', 'fix the failing test\r');
    h.host.onRendererInput('sh1', '\x1b[A\r');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
  });

  it('notice rule: `claude`, connect, the connection closes, then `ls` → a later client stays pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const first = await client(h.ep, token, 'claude-code');
    first.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected ?? false).toBe(false);
    h.host.onRendererInput('sh1', 'ls\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: `claude`, connect, Ctrl+Z → pull-only while it is suspended', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    h.host.onRendererInput('sh1', '\x1a');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: a second claude-code client never binds; when the bound one closes → pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const bound = await client(h.ep, token, 'claude-code');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([composeNotice(false), '\r']);
    bound.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    expect(h.host.uiState().sessions.sh1?.connected).toBe(true);
  });

  it('SF-1 a bound claude with a plain `❯ ` prompt and no rules on screen → nothing typed', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('no-empty-input');
  });

  for (const [key, byte] of [
    ['Ctrl+C', '\x03'],
    ['Ctrl+D', '\x04'],
  ] as const) {
    it(`SF-1 \`claude\` typed, ${key} out of it unconnected, then a claude-code client connects → pull-only`, async () => {
      const h = harness();
      const ca = await sender(h);
      const { token } = shell(h, 'sh1');
      h.host.onRendererInput('sh1', 'claude\r');
      h.host.onRendererInput('sh1', byte);
      await client(h.ep, token, 'claude-code');
      claudeBox(h, 'sh1');
      settle(h);
      await ca.call('send_message', { to: ['claude-1'], body: 'see' });
      await h.host.tick();
      expect(writesTo(h, 'sh1')).toEqual([]);
      expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    });
  }

  it('SF-3 a relaunch ends the binding even while the old connection is still open', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, token, 'claude-code');
    shell(h, 'sh1');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('SF-3 a relaunch drops the typed line: a client of the new generation does not bind', async () => {
    const h = harness();
    const ca = await sender(h);
    shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const { token } = shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    claudeBox(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: a connection that initialized before the `claude` line does not count', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    await client(h.ep, token, 'claude-code');
    h.host.onRendererInput('sh1', 'claude\r');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
  });

  it('notice rule: `codex` typed, then a claude-code client connects → pull-only', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'codex\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
  });

  it('notice rule: a recalled line the tracker cannot read never binds', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', '\x1b[A\r');
    await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
  });

  it('AC3 opencode / unmapped client → pull-only, nothing typed', async () => {
    const h = harness();
    const ca = await sender(h);
    const sh1 = shell(h, 'sh1');
    const sh2 = shell(h, 'sh2');
    h.host.onRendererInput('sh1', 'opencode\r');
    h.host.onRendererInput('sh2', 'claude\r');
    await client(h.ep, sh1.token, 'opencode');
    await client(h.ep, sh2.token, 'some-ide');
    for (const id of ['sh1', 'sh2']) idlePrompt(h, id);
    settle(h);
    await ca.call('send_message', { to: ['opencode-1', 'agent-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(writesTo(h, 'sh2')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    expect(h.host.uiState().sessions.sh2?.gate).toBe('pull-only');
  });

  it('AC3 no live connection → no notice; badge gate null for a non-adapter session', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    const c = await client(h.ep, token, 'claude-code');
    idlePrompt(h, 'sh1');
    await ca.call('send_message', { to: ['claude-1'], body: 'first' });
    c.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.connected).toBe(false);
    settle(h);
    await ca.call('send_message', { to: ['claude-1'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBeNull();
  });

  it('AC3 the bound CLI decides; a later client of another CLI or an unmapped one is skipped', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'codex\r');
    const codex = await client(h.ep, token, 'codex-mcp-client');
    await client(h.ep, token, 'claude-code');
    await client(h.ep, token, 'opencode');
    idlePrompt(h, 'sh1');
    settle(h);
    await ca.call('send_message', { to: ['codex-1'], body: 'see' });
    await h.host.tick();
    // Bound to Codex, whose composer is not on screen: Claude's `❯` row never admits the notice.
    expect(writesTo(h, 'sh1')).toEqual([]);
    expect(h.host.uiState().sessions.sh1?.gate).toBe('no-empty-input');
    codex.sock.destroy();
    await expect.poll(() => h.host.uiState().sessions.sh1?.gate).toBe('pull-only');
    await h.host.tick();
    expect(writesTo(h, 'sh1')).toEqual([]);
  });

  it('definition adapter still wins in a profile session', async () => {
    const h = harness();
    const ca = await sender(h);
    const { token } = launch(h, 's2');
    await client(h.ep, token, 'claude-code');
    h.host.onOutput('s2', 'fake❯ ');
    h.echo.add('s2');
    settle(h);
    await ca.call('send_message', { to: ['fake-2'], body: 'see' });
    await h.host.tick();
    expect(writesTo(h, 's2')).toEqual([composeNotice(false), '\r']);
  });

  it("D6 a shell's screen model starts at its first initialize with the last known size, not at spawn", async () => {
    const h = harness();
    await h.host.start();
    const start = vi.spyOn(h.screens, 'start');
    const { token } = shell(h, 'sh1');
    h.host.onResize('sh1', 100, 30);
    expect(h.screens.has('sh1')).toBe(false);
    await client(h.ep, token, 'claude-code');
    expect(h.screens.has('sh1')).toBe(true);
    expect(start).toHaveBeenCalledWith('sh1', 100, 30);
    await client(h.ep, token, 'codex-mcp-client');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a profile session still starts its screen model at spawn', async () => {
    const h = harness();
    await h.host.start();
    launch(h, 's1');
    expect(h.screens.has('s1')).toBe(true);
  });
});

describe('typed-command detection → notConnected (spec 2026-10-27-conduit-mcp-install §2.5, AC11)', () => {
  const shell = (h: Harness, id: string) => launch(h, id, SHELL, spec('/usr/bin/pwsh'));
  const notConnected = (h: Harness) => h.host.uiState().notConnected;
  async function typedAndWaited(h: Harness, id: string, line: string) {
    h.host.onRendererInput(id, line);
    h.clock.t += GRACE;
    await h.host.tick();
  }

  it('AC11 typed codex + no initialize within the grace → notConnected {cli: codex, install, reason: no-initialize}', async () => {
    const h = harness();
    await h.host.start();
    shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'codex\r');
    h.clock.t += GRACE - 1;
    await h.host.tick();
    expect(notConnected(h)).toEqual({});
    h.clock.t += 1;
    await h.host.tick();
    expect(notConnected(h)).toEqual({
      sh1: { cli: 'codex', install: 'not-installed', launch: 1, reason: 'no-initialize' },
    });
    await expect
      .poll(() =>
        h.broadcasts.some((b) => b.type === 'mcp:state' && b.state.notConnected.sh1 !== undefined),
      )
      .toBe(true);
  });

  it('AC11 detection runs before the store has loaded (tick before the notifier exists)', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const io = failingIo();
    io.fail = false;
    const slow: StoreIo = { ...io, readLog: async () => (await gate, undefined) };
    const h = harness({ storeIo: slow });
    const started = h.host.start();
    await expect
      .poll(() => {
        h.sessions.set('sh1', session('sh1', { agentId: 'pwsh' }));
        return h.host.prepareLaunch('sh1', SHELL, spec('/usr/bin/pwsh')).env?.CONDUIT_SESSION_TOKEN;
      })
      .toBeDefined();
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.cli).toBe('claude');
    release();
    await started;
  });

  it('AC11 initialize inside the grace → nothing; initialize after → cleared', async () => {
    const h = harness();
    await h.host.start();
    const a = shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'claude\r');
    await client(h.ep, a.token, 'claude-code');
    h.clock.t += GRACE;
    await h.host.tick();
    expect(notConnected(h)).toEqual({});

    const b = shell(h, 'sh2');
    await typedAndWaited(h, 'sh2', 'claude\r');
    expect(notConnected(h).sh2?.reason).toBe('no-initialize');
    await client(h.ep, b.token, 'claude-code');
    expect(notConnected(h)).toEqual({});
  });

  it('AC11 exit clears; relaunch clears and bumps launch', async () => {
    const h = harness();
    await h.host.start();
    shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.launch).toBe(1);
    h.host.onExit('sh1');
    expect(notConnected(h)).toEqual({});
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h)).toEqual({});

    shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.launch).toBe(2);
    shell(h, 'sh1');
    expect(notConnected(h)).toEqual({});
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(notConnected(h).sh1?.launch).toBe(3);
  });

  it('AC11 skip-list line is not a candidate', async () => {
    const h = harness();
    await h.host.start();
    shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'codex --help\r');
    await typedAndWaited(h, 'sh1', 'claude mcp list\r');
    expect(notConnected(h)).toEqual({});
  });

  it('N2 focus reports and device-attribute replies mid-line are not typed input', async () => {
    const h = harness();
    await h.host.start();
    shell(h, 'sh1');
    h.host.onRendererInput('sh1', 'cod');
    h.host.onRendererInput('sh1', '\x1b[I');
    h.host.onRendererInput('sh1', '\x1b[?1;2c');
    h.host.onRendererInput('sh1', 'ex\x1b[O\r');
    h.clock.t += GRACE;
    await h.host.tick();
    expect(notConnected(h).sh1?.cli).toBe('codex');
  });

  it('adapter sessions never detect', async () => {
    const h = harness();
    await h.host.start();
    launch(h, 's1');
    launch(h, 'c1', CODEX, spec('/usr/bin/codex'));
    await typedAndWaited(h, 's1', 'codex\r');
    await typedAndWaited(h, 'c1', 'claude\r');
    expect(notConnected(h)).toEqual({});
  });

  it('a line typed while a CLI is live is ignored', async () => {
    const h = harness();
    await h.host.start();
    await client(h.ep, shell(h, 'sh1').token, 'claude-code');
    await typedAndWaited(h, 'sh1', 'codex\r');
    expect(notConnected(h)).toEqual({});
  });

  it('messaging off → notConnected {}', async () => {
    let on = true;
    const h = harness({ messagingOn: () => on });
    await h.host.start();
    shell(h, 'sh1');
    await typedAndWaited(h, 'sh1', 'claude\r');
    expect(Object.keys(notConnected(h))).toEqual(['sh1']);
    on = false;
    expect(notConnected(h)).toEqual({});
  });

  it('cursor-not-connected profile launch → notConnected {cli: cursor, reason: cursor-not-connected}', async () => {
    const h = harness({ installState: (cli) => (cli === 'cursor' ? 'conflict' : 'not-installed') });
    await h.host.start();
    h.sessions.set('c1', session('c1', { agentId: 'cursor' }));
    h.host.prepareLaunch('c1', CURSOR, spec('/usr/bin/agent'));
    expect(notConnected(h)).toEqual({
      c1: { cli: 'cursor', install: 'conflict', launch: 1, reason: 'cursor-not-connected' },
    });
    // A Cursor client connecting cannot clear it: the session never got a token.
    h.host.onExit('c1');
    expect(notConnected(h)).toEqual({});
  });

  it('onInstallChanged re-reads install state and broadcasts; only for the CLIs shown', async () => {
    const reads: string[] = [];
    let claude: 'not-installed' | 'installed' = 'not-installed';
    const h = harness({
      installState: (cli) => {
        reads.push(cli);
        return cli === 'claude' ? claude : 'not-installed';
      },
    });
    await h.host.start();
    shell(h, 'sh1');
    shell(h, 'sh2');
    await typedAndWaited(h, 'sh1', 'claude\r');
    await typedAndWaited(h, 'sh2', 'claude\r');
    reads.length = 0;
    claude = 'installed';
    const before = h.broadcasts.length;
    h.host.onInstallChanged();
    expect(reads).toEqual(['claude']);
    expect(notConnected(h).sh1?.install).toBe('installed');
    expect(notConnected(h).sh2?.install).toBe('installed');
    await expect.poll(() => h.broadcasts.length).toBeGreaterThan(before);
  });
});
