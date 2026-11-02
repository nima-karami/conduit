import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShimEndpoint } from '../../server/mcp/endpoint';
import type { EndpointConnection, McpEndpoint } from '../../src/conduit-mcp/host';
import {
  FALLBACK_CAPABILITIES,
  SHIM_CONNECT_BUFFER_MAX_BYTES,
  SHIM_ERROR_RPC_CODE,
  SHIM_ERRORS,
  SHIM_HELLO_MAX_BYTES,
  SHIM_INITIAL_CONNECT_DEADLINE_MS,
  SHIM_PROTOCOL_GENERATION,
  SHIM_RECONNECT,
  SHIM_WELCOME_TIMEOUT_MS,
} from '../../src/contracts/shim-protocol';
import { testEndpoint } from '../helpers/test-endpoint';

const SHIM = path.join(__dirname, '..', '..', 'resources', 'conduit-mcp', 'conduit-mcp-shim.cjs');
const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'contracts', 'shim-hello.json'), 'utf8'),
) as {
  transitions: Array<{
    name: string;
    hellos: string[];
    initializeResponses: number;
    initializedRead?: boolean;
    phaseAfter: string;
    stateAfter?: string;
    errorSent?: string;
  }>;
};
const transition = (name: string) => {
  const t = FIXTURES.transitions.find((x) => x.name === name);
  if (!t) throw new Error(`no fixture ${name}`);
  return t;
};
const noLog = { debug: () => undefined, warn: () => undefined };
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
/** The fixtures' client: Codex's initialize, verbatim. */
const CODEX_INIT = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'codex-mcp-client', version: '0.40.0' },
  },
};
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';

/** A --require preload that delays net.connect, so stdin is provably read before the connect. */
function delayedConnectPreload(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-shim-'));
  const file = path.join(dir, 'delay-connect.cjs');
  fs.writeFileSync(
    file,
    [
      "const net = require('node:net');",
      'net.connect = (...a) => {',
      '  const s = new net.Socket();',
      '  setTimeout(() => s.connect(...a), 400);',
      '  return s;',
      '};',
      '',
    ].join('\n'),
  );
  preloadDirs.push(dir);
  return file;
}
const preloadDirs: string[] = [];

interface Shim {
  child: ChildProcessWithoutNullStreams;
  nextLine(): Promise<string>;
  /** Every stdout line so far. */
  out: string[];
  write(line: string | Record<string, unknown>): void;
  exit: Promise<number | null>;
}

const children: ChildProcessWithoutNullStreams[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const close of closers.splice(0)) await close();
  for (const d of preloadDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function start(
  endpoint: string | undefined,
  token: string | undefined,
  opts: { preload?: string; envEndpoint?: string } = {},
): Shim {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CONDUIT_SESSION_TOKEN;
  delete env.CONDUIT_MCP_ENDPOINT;
  if (token !== undefined) env.CONDUIT_SESSION_TOKEN = token;
  if (opts.envEndpoint !== undefined) env.CONDUIT_MCP_ENDPOINT = opts.envEndpoint;
  const pre = opts.preload ? ['--require', opts.preload] : [];
  const args = endpoint === undefined ? [] : ['--endpoint', endpoint];
  const child = spawn(process.execPath, [...pre, SHIM, ...args], { env });
  children.push(child);
  let buf = '';
  const out: string[] = [];
  const queued: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      out.push(line);
      const w = waiters.shift();
      if (w) w(line);
      else queued.push(line);
      i = buf.indexOf('\n');
    }
  });
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    exit,
    out,
    write: (l) => child.stdin.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`),
    nextLine: () => {
      const q = queued.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** The real C6 endpoint with a stub host: every connection it handed the host. */
async function realHost(
  tokens: string[],
  onConnection: (c: EndpointConnection) => void = () => undefined,
): Promise<{ path: string; conns: EndpointConnection[] }> {
  const p = testEndpoint();
  const conns: EndpointConnection[] = [];
  const ep: McpEndpoint = createShimEndpoint({
    path: p,
    log: noLog,
    tokens: {
      rows: () => ({
        state: 'loaded',
        rows: tokens.map((t) => ({
          sessionId: 's',
          sha256: sha(t),
          generation: 1,
          launchId: 'a'.repeat(32),
          state: 'live' as const,
          hcAddress: 'hc',
          createdAt: '',
        })),
      }),
    },
    onConnection: (c) => {
      conns.push(c);
      onConnection(c);
    },
  });
  expect((await ep.listen()).ok).toBe(true);
  closers.push(() => ep.close());
  return { path: p, conns };
}

interface FakeConn {
  hello: string | undefined;
  lines: string[];
  welcome(reason?: 'unknown_token' | 'unsupported_generation' | 'draining'): void;
  send(msg: Record<string, unknown>): void;
  drop(): void;
}

/**
 * A hand-driven C6 server: the test decides each welcome, reply and drop. `auto` welcomes ok and
 * answers initialize. It can stop and listen again on the same path, as a restarting server does.
 */
function fakeServer(opts: { auto?: boolean } = {}) {
  const p = testEndpoint();
  const conns: FakeConn[] = [];
  const hellos: string[] = [];
  let server: net.Server | undefined;
  const sockets = new Set<net.Socket>();
  const accept = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buf = '';
    const conn: FakeConn = {
      hello: undefined,
      lines: [],
      welcome: (reason) =>
        socket.write(
          `${JSON.stringify(reason ? { conduit: 2, ok: false, reason } : { conduit: 2, ok: true })}\n`,
        ),
      send: (msg) => socket.write(`${JSON.stringify(msg)}\n`),
      drop: () => socket.destroy(),
    };
    conns.push(conn);
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      buf += d;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (conn.hello === undefined) {
          conn.hello = line;
          hellos.push(line);
          if (opts.auto) conn.welcome();
        } else {
          conn.lines.push(line);
          const msg = JSON.parse(line);
          if (opts.auto && msg.method === 'initialize')
            conn.send({ jsonrpc: '2.0', id: msg.id, result: { from: 'server' } });
        }
        i = buf.indexOf('\n');
      }
    });
  };
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      if (process.platform !== 'win32') fs.rmSync(p, { force: true });
      server = net.createServer(accept);
      server.once('error', reject);
      server.listen(p, () => resolve());
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
  closers.push(stop);
  return { path: p, conns, hellos, listen, stop };
}

const initResponses = (s: Shim) =>
  s.out.map((l) => JSON.parse(l)).filter((m) => m.id === 0 && (m.result || m.error));
const until = async (f: () => boolean, ms = 10_000) => {
  await expect.poll(f, { timeout: ms, interval: 20 }).toBe(true);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('conduit-mcp-shim: v0.51 behaviour kept', () => {
  it('hello carries the env token', async () => {
    const h = await realHost(['abc']);
    start(h.path, 'abc');
    await until(() => h.conns.length === 1);
    expect(h.conns[0]?.token).toBe('abc');
  });

  it('uses the endpoint env var when --endpoint is absent', async () => {
    const h = await realHost(['abc']);
    start(undefined, 'abc', { envEndpoint: h.path });
    await until(() => h.conns.length === 1);
    expect(h.conns[0]?.token).toBe('abc');
  });

  it('treats a literal endpoint placeholder as absent and exits on stdin end', async () => {
    const s = start(undefined, undefined, { envEndpoint: '${env:CONDUIT_MCP_ENDPOINT}' });
    s.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(JSON.parse(await s.nextLine())).toMatchObject({
      id: 1,
      result: { capabilities: FALLBACK_CAPABILITIES },
    });
    s.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    expect(JSON.parse(await s.nextLine())).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [] },
    });
    s.child.stdin.end();
    expect(await s.exit).toBe(0);
  });

  it('sends a null token for a literal token placeholder, or none', async () => {
    const h = await realHost([]);
    start(h.path, '${env:CONDUIT_SESSION_TOKEN}');
    start(h.path, undefined);
    await until(() => h.conns.length === 2);
    expect(h.conns.map((c) => c.token)).toEqual([null, null]);
  });

  it('relays whole lines both ways unchanged', async () => {
    const h = await realHost(['t'], (c) => c.onLine((l) => c.send(l)));
    const s = start(h.path, 't');
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'x',
      params: { s: `é✓${'a'.repeat(200 * 1024)}` },
    });
    s.write(big);
    expect(await s.nextLine()).toBe(big);
  });

  it('stdin written before connect is delivered after the welcome', async () => {
    const got: string[] = [];
    const h = await realHost(['t'], (c) => c.onLine((l) => got.push(l)));
    start(h.path, 't', { preload: delayedConnectPreload() }).write(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    );
    await expect
      .poll(() => got, { timeout: 10_000 })
      .toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
  });

  it('stdin end → exit 0 (host up and host down)', async () => {
    const h = await realHost(['t']);
    const up = start(h.path, 't');
    await until(() => h.conns.length === 1);
    up.child.stdin.end();
    expect(await up.exit).toBe(0);
    const down = start(testEndpoint(), 't');
    down.child.stdin.end();
    expect(await down.exit).toBe(0);
  });

  it('shim requires only node:net', () => {
    const src = fs.readFileSync(SHIM, 'utf8');
    const requires = [...src.matchAll(/require\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((m) => m[2]);
    expect(requires).toEqual(['node:net']);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect((src.match(/require\(/g) ?? []).length).toBe(1);
  });
});

describe('conduit-mcp-shim: C6', () => {
  it('mirrors the frozen C6 constants', () => {
    const src = fs.readFileSync(SHIM, 'utf8');
    const m = src.match(/^const C6 = JSON\.parse\(\s*'([^']*)',?\s*\);/m);
    expect(m).not.toBeNull();
    expect(JSON.parse(m?.[1] ?? '{}')).toEqual({
      generation: SHIM_PROTOCOL_GENERATION,
      reconnect: SHIM_RECONNECT,
      welcomeTimeoutMs: SHIM_WELCOME_TIMEOUT_MS,
      initialConnectDeadlineMs: SHIM_INITIAL_CONNECT_DEADLINE_MS,
      connectBufferMaxBytes: SHIM_CONNECT_BUFFER_MAX_BYTES,
      helloMaxBytes: SHIM_HELLO_MAX_BYTES,
      fallbackCapabilities: FALLBACK_CAPABILITIES,
      errors: SHIM_ERRORS,
      errorRpcCode: SHIM_ERROR_RPC_CODE,
      build: '0.52.0',
    });
  });

  it('host down: the 2 s initial-connect FALLBACK answers initialize locally, then the rest', async () => {
    const s = start(testEndpoint(), 't');
    const t0 = Date.now();
    s.write({ ...CODEX_INIT, id: 1 });
    s.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    const init = JSON.parse(await s.nextLine());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SHIM_INITIAL_CONNECT_DEADLINE_MS - 100);
    expect(init).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: FALLBACK_CAPABILITIES,
        serverInfo: { name: 'conduit', version: 'fallback' },
      },
    });
    // Buffered with the initialize: host_unavailable, not a local answer.
    expect(JSON.parse(await s.nextLine())).toMatchObject({
      id: 2,
      error: { code: SHIM_ERROR_RPC_CODE, data: { code: 'host_unavailable', retryable: true } },
    });
    s.write(INITIALIZED);
    s.write('{"jsonrpc":"2.0","id":3,"method":"tools/list"}');
    expect(JSON.parse(await s.nextLine())).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { tools: [] },
    });
    s.write('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_sessions"}}');
    const call = JSON.parse(await s.nextLine());
    expect(call.result.isError).toBe(true);
    expect(JSON.parse(call.result.content[0].text).error).toMatchObject({
      code: 'host_unavailable',
      retryable: true,
    });
  });

  it('a drop fails written requests with outcome_unknown, keeps ids distinct, honours cancellation', async () => {
    const f = fakeServer({ auto: true });
    await f.listen();
    const s = start(f.path, 'tok_7c20e4');
    s.write(CODEX_INIT);
    await until(() => initResponses(s).length === 1);
    s.write(INITIALIZED);
    s.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a"}}');
    s.write('{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"b"}}');
    s.write('{"jsonrpc":"2.0","id":2,"method":"ping"}');
    await until(() => (f.conns[0]?.lines.length ?? 0) === 5);
    s.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}');
    await until(() => (f.conns[0]?.lines.length ?? 0) === 6);
    f.conns[0]?.send({ jsonrpc: '2.0', id: '1', result: { content: [] } });
    await until(() => s.out.some((l) => JSON.parse(l).id === '1'));
    f.conns[0]?.drop();
    await until(() => s.out.some((l) => JSON.parse(l).id === 1));
    const one = s.out.map((l) => JSON.parse(l)).find((m) => m.id === 1);
    expect(JSON.parse(one.result.content[0].text).error).toMatchObject({
      code: 'outcome_unknown',
      retryable: false,
    });
    await until(() => f.conns.length === 2);
    await sleep(200);
    const all = s.out.map((l) => JSON.parse(l));
    // The string id was answered by the host; the cancelled ping gets nothing fabricated.
    expect(all.filter((m) => m.id === '1')).toHaveLength(1);
    expect(all.filter((m) => m.id === 2)).toEqual([]);
    // Reconnected after init-done: the hello resumes.
    expect(JSON.parse(f.hellos[1] ?? '{}').resume).toMatchObject({ initialized: true });
  });

  it('welcome unknown_token → permanent fallback, no retry; the pending initialize is answered once', async () => {
    const f = fakeServer();
    await f.listen();
    const s = start(f.path, 'tok');
    s.write(CODEX_INIT);
    await until(() => f.conns[0]?.hello !== undefined);
    f.conns[0]?.welcome('unknown_token');
    await until(() => initResponses(s).length === 1);
    expect(initResponses(s)[0].result.serverInfo).toEqual({ name: 'conduit', version: 'fallback' });
    await sleep(SHIM_RECONNECT.firstMs * 4);
    expect(f.conns).toHaveLength(1);
  });

  it('welcome draining → retry', async () => {
    const f = fakeServer();
    await f.listen();
    start(f.path, 'tok');
    await until(() => f.conns[0]?.hello !== undefined);
    f.conns[0]?.welcome('draining');
    await until(() => f.conns.length === 2);
  });

  it('no welcome within SHIM_WELCOME_TIMEOUT_MS is a failed connect, retried', async () => {
    const f = fakeServer();
    await f.listen();
    start(f.path, 'tok');
    await until(() => f.conns.length === 1);
    await sleep(SHIM_WELCOME_TIMEOUT_MS - 500);
    expect(f.conns).toHaveLength(1);
    await until(() => f.conns.length === 2, SHIM_WELCOME_TIMEOUT_MS + 2_000);
  });

  it('welcome unsupported_generation → permanent fallback, no retry', async () => {
    const f = fakeServer();
    await f.listen();
    const s = start(f.path, 'tok');
    s.write(CODEX_INIT);
    await until(() => f.conns[0]?.hello !== undefined);
    f.conns[0]?.welcome('unsupported_generation');
    await until(() => initResponses(s).length === 1);
    expect(initResponses(s)[0].result.serverInfo.version).toBe('fallback');
    await sleep(SHIM_RECONNECT.firstMs * 4);
    expect(f.conns).toHaveLength(1);
  });

  it('past SHIM_CONNECT_BUFFER_MAX_BYTES a request gets host_unavailable; an overflowed initialize is forgotten', async () => {
    const f = fakeServer();
    await f.listen();
    const s = start(f.path, 'tok_7c20e4');
    await until(() => f.conns[0]?.hello !== undefined);
    const big = {
      ...CODEX_INIT,
      params: { ...CODEX_INIT.params, pad: 'x'.repeat(SHIM_CONNECT_BUFFER_MAX_BYTES) },
    };
    s.write(big);
    await until(() => initResponses(s).length === 1);
    expect(initResponses(s)[0]).toMatchObject({ error: { data: { code: 'host_unavailable' } } });
    f.conns[0]?.welcome();
    // Id 0 again, now for an ordinary request: had the initialize stayed cached, its answer would
    // read as a handshake and the next hello would resume one the client never had.
    s.write('{"jsonrpc":"2.0","id":0,"method":"tools/list"}');
    await until(() => f.conns[0]?.lines.length === 1);
    expect(JSON.parse(f.conns[0]?.lines[0] ?? '{}').method).toBe('tools/list');
    f.conns[0]?.send({ jsonrpc: '2.0', id: 0, result: { tools: [] } });
    await until(() => s.out.length === 2);
    f.conns[0]?.drop();
    await until(() => f.conns[1]?.hello !== undefined);
    expect(JSON.parse(f.hellos[1] ?? '{}').resume).toBeNull();
  });

  it('a connect error and its close schedule exactly one retry', async () => {
    // Nothing listens, so every attempt fails with an error followed by a close. A preload
    // counts the attempts on stderr.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcp-shim-'));
    preloadDirs.push(dir);
    const preload = path.join(dir, 'count-connect.cjs');
    fs.writeFileSync(
      preload,
      [
        "const net = require('node:net');",
        'const connect = net.connect;',
        "net.connect = (...a) => { process.stderr.write('CONNECT\\n'); return connect(...a); };",
        '',
      ].join('\n'),
    );
    const s = start(testEndpoint(), 'tok', { preload });
    let stderr = '';
    s.child.stderr.setEncoding('utf8');
    s.child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    // Backoff 250, 500, 1000: attempts at about 0, 250, 750 and 1750 ms. A second retry per
    // failure would double that.
    await sleep(1_900);
    const attempts = stderr.split('\n').filter((l) => l === 'CONNECT').length;
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it('stdout EPIPE → exit', async () => {
    const s = start(undefined, undefined);
    s.child.stdout.destroy();
    s.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    s.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    expect(await s.exit).toBe(0);
  });
});

describe('conduit-mcp-shim: recorded C6 transitions', () => {
  it('drop in init-pending, reconnect within the deadline', async () => {
    const t = transition('drop in init-pending, reconnect within the deadline');
    const f = fakeServer();
    await f.listen();
    const s = start(f.path, 'tok_7c20e4');
    s.write(CODEX_INIT);
    await until(() => f.conns[0]?.hello !== undefined);
    f.conns[0]?.welcome();
    await until(() => f.conns[0]?.lines.length === 1);
    f.conns[0]?.drop();
    await until(() => f.conns[1]?.hello !== undefined);
    f.conns[1]?.welcome();
    // Re-sent with the same id, never failed with outcome_unknown.
    await until(() => f.conns[1]?.lines.length === 1);
    expect(JSON.parse(f.conns[1]?.lines[0] ?? '')).toEqual(CODEX_INIT);
    expect(s.out).toEqual([]);
    expect(f.hellos).toEqual(t.hellos);
    expect(initResponses(s)).toHaveLength(t.initializeResponses);
    f.conns[1]?.send({ jsonrpc: '2.0', id: 0, result: { from: 'server' } });
    await until(() => initResponses(s).length === 1);
  });

  it('drop in init-pending, no reconnect within the deadline', async () => {
    const t = transition('drop in init-pending, no reconnect within the deadline');
    const f = fakeServer();
    await f.listen();
    const s = start(f.path, 'tok_7c20e4');
    s.write(CODEX_INIT);
    await until(() => f.conns[0]?.hello !== undefined);
    f.conns[0]?.welcome();
    await until(() => f.conns[0]?.lines.length === 1);
    await f.stop();
    await until(() => initResponses(s).length === 1, SHIM_INITIAL_CONNECT_DEADLINE_MS + 3_000);
    s.write(INITIALIZED);
    await sleep(100);
    await f.listen();
    await until(() => f.conns[1]?.hello !== undefined, 10_000);
    expect(f.hellos).toEqual(t.hellos);
    f.conns[1]?.welcome();
    await sleep(300);
    expect(initResponses(s)).toHaveLength(t.initializeResponses);
  });

  it('FALLBACK entered in idle', async () => {
    const t = transition('FALLBACK entered in idle');
    const f = fakeServer();
    start(f.path, 'tok_7c20e4');
    await sleep(SHIM_INITIAL_CONNECT_DEADLINE_MS + 200);
    await f.listen();
    await until(() => f.conns[0]?.hello !== undefined, 10_000);
    expect(f.hellos).toEqual(t.hellos);
  });

  it('FALLBACK with a buffered initialize', async () => {
    const t = transition('FALLBACK with a buffered initialize');
    const f = fakeServer();
    const s = start(f.path, 'tok_7c20e4');
    s.write(CODEX_INIT);
    await until(() => initResponses(s).length === 1, SHIM_INITIAL_CONNECT_DEADLINE_MS + 3_000);
    s.write(INITIALIZED);
    await sleep(100);
    await f.listen();
    await until(() => f.conns[0]?.hello !== undefined, 10_000);
    expect(f.hellos).toEqual(t.hellos);
    f.conns[0]?.welcome();
    await sleep(300);
    expect(initResponses(s)).toHaveLength(t.initializeResponses);
  });

  it('local initialize between hello and welcome', async () => {
    const t = transition('local initialize between hello and welcome');
    const f = fakeServer();
    await f.listen();
    const s = start(f.path, 'tok_7c20e4');
    // Read by the shim before the deadline's local answer: that hello resumes initialized:true.
    s.write(CODEX_INIT);
    s.write(INITIALIZED);
    await until(() => f.conns[0]?.hello !== undefined);
    await until(() => initResponses(s).length === 1, SHIM_INITIAL_CONNECT_DEADLINE_MS + 3_000);
    // At once, not at the first attempt's welcome timeout (a second later).
    await until(() => f.conns[1]?.hello !== undefined, 600);
    // The abandoned attempt's welcome is ignored; the new one promotes.
    f.conns[0]?.welcome();
    f.conns[1]?.welcome();
    await sleep(300);
    expect(f.hellos).toEqual(t.hellos);
    expect(initResponses(s)).toHaveLength(t.initializeResponses);
    // Nothing reached the abandoned attempt, and the answered initialize is never re-sent.
    expect(f.conns[0]?.lines).toEqual([]);
    expect(f.conns[1]?.lines.filter((l) => l.includes('"initialize"'))).toEqual([]);
  });

  it('local initialize before the client sent notifications/initialized', async () => {
    const t = transition('local initialize before the client sent notifications/initialized');
    const f = fakeServer();
    const s = start(f.path, 'tok_7c20e4');
    s.write(CODEX_INIT);
    await until(() => initResponses(s).length === 1, SHIM_INITIAL_CONNECT_DEADLINE_MS + 3_000);
    await f.listen();
    await until(() => f.conns[0]?.hello !== undefined, 10_000);
    expect(f.hellos).toEqual(t.hellos);
    f.conns[0]?.welcome();
    // Order gate: the ping reaching the server proves the attempt promoted, so the notification
    // below is relayed on it rather than read while its hello is still out.
    s.write('{"jsonrpc":"2.0","id":9,"method":"ping"}');
    await until(() => f.conns[0]?.lines.some((l) => JSON.parse(l).id === 9) === true);
    s.write(INITIALIZED);
    // The server waits for it on the relayed stream.
    await until(() => f.conns[0]?.lines.includes(INITIALIZED) === true);
    expect(f.hellos).toEqual(t.hellos);
    expect(initResponses(s)).toHaveLength(t.initializeResponses);
  });

  it('notifications/initialized read while a resume hello is out re-hellos, never lost', async () => {
    const f = fakeServer();
    await f.listen();
    const s = start(f.path, 'tok_7c20e4');
    s.write(CODEX_INIT);
    // The welcome is held: at the deadline the shim answers locally and re-hellos with resume.
    await until(() => initResponses(s).length === 1, SHIM_INITIAL_CONNECT_DEADLINE_MS + 3_000);
    await until(() => f.conns[1]?.hello !== undefined, 600);
    expect(JSON.parse(f.hellos[1] ?? '{}').resume.initialized).toBe(false);
    // Read in FALLBACK with that hello still unanswered.
    s.write(INITIALIZED);
    await until(() => f.conns[2]?.hello !== undefined, 600);
    expect(JSON.parse(f.hellos[2] ?? '{}').resume.initialized).toBe(true);
    f.conns[2]?.welcome();
    // Queued, not dropped: relayed on the attempt that promoted.
    await until(() => f.conns[2]?.lines.includes(INITIALIZED) === true);
    expect(initResponses(s)).toHaveLength(1);
  });

  it('resume hello past the size limit', async () => {
    const t = transition('resume hello past the size limit');
    const f = fakeServer({ auto: true });
    await f.listen();
    const s = start(f.path, 'tok_7c20e4');
    const big = {
      ...CODEX_INIT,
      params: { ...CODEX_INIT.params, capabilities: { pad: 'x'.repeat(SHIM_HELLO_MAX_BYTES) } },
    };
    s.write(big);
    await until(() => initResponses(s).length === 1);
    s.write(INITIALIZED);
    await until(() => f.conns[0]?.lines.length === 2);
    f.conns[0]?.drop();
    await sleep(SHIM_RECONNECT.firstMs * 3);
    // No hello after the drop.
    expect(f.hellos.slice(1)).toEqual(t.hellos);
    const byId = (id: number) => s.out.map((l) => JSON.parse(l)).filter((m) => m.id === id);
    s.write('{"jsonrpc":"2.0","id":5,"method":"tools/list"}');
    await until(() => byId(5).length === 1);
    expect(byId(5)[0]).toMatchObject({
      error: { data: { code: t.errorSent, retryable: false } },
    });
    // permanent_fallback: answered locally from now on, and never reconnects.
    s.write('{"jsonrpc":"2.0","id":6,"method":"tools/list"}');
    await until(() => byId(6).length === 1);
    expect(byId(6)).toEqual([{ jsonrpc: '2.0', id: 6, result: { tools: [] } }]);
    expect(f.conns).toHaveLength(1);
    expect(initResponses(s)).toHaveLength(t.initializeResponses);
  });
});

describe('conduit-mcp-shim: end to end with the server endpoint', () => {
  it('a restart resumes: the host sees the cached initialize, the client one response', async () => {
    const seen: string[] = [];
    const answer = (c: EndpointConnection) =>
      c.onLine((l) => {
        seen.push(l);
        const msg = JSON.parse(l);
        if (msg.method === 'initialize')
          c.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { from: 'host' } }));
      });
    const h = await realHost(['tok'], answer);
    const s = start(h.path, 'tok');
    s.write(CODEX_INIT);
    await until(() => initResponses(s).length === 1);
    s.write(INITIALIZED);
    await until(() => seen.length === 2);
    h.conns[0]?.close();
    await until(() => h.conns.length === 2, 10_000);
    await until(() => s.out.some((l) => l.includes('notifications/tools/list_changed')));
    expect(initResponses(s)).toHaveLength(1);
    expect(seen.filter((l) => JSON.parse(l).method === 'initialize')).toHaveLength(2);
    expect(JSON.parse(seen.at(-1) ?? '{}').params).toEqual(CODEX_INIT.params);
  });
});
