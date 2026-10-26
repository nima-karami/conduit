import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMcpEndpoint,
  type EndpointConnection,
  type McpEndpoint,
} from '../../electron/conduit-mcp-endpoint';
import { testEndpoint } from '../helpers/test-endpoint';

const SHIM = path.join(__dirname, '..', '..', 'resources', 'conduit-mcp', 'conduit-mcp-shim.cjs');
const noLog = { debug: () => undefined, warn: () => undefined };

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
  exit: Promise<number | null>;
}

function runShim(
  endpoint: string | undefined,
  token: string | undefined,
  preload?: string,
  envEndpoint?: string,
): Shim {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CONDUIT_SESSION_TOKEN;
  delete env.CONDUIT_MCP_ENDPOINT;
  if (token !== undefined) env.CONDUIT_SESSION_TOKEN = token;
  if (envEndpoint !== undefined) env.CONDUIT_MCP_ENDPOINT = envEndpoint;
  const pre = preload ? ['--require', preload] : [];
  const args = endpoint === undefined ? [] : ['--endpoint', endpoint];
  const child = spawn(process.execPath, [...pre, SHIM, ...args], { env });
  let buf = '';
  const queued: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
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
    nextLine: () => {
      const q = queued.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

describe('conduit-mcp-shim', () => {
  let ep: McpEndpoint | undefined;
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) c.kill();
    for (const d of preloadDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    await ep?.close();
    ep = undefined;
  });

  async function host(onConnection: (c: EndpointConnection) => void): Promise<string> {
    const p = testEndpoint();
    ep = createMcpEndpoint({ path: p, onConnection, log: noLog });
    expect((await ep.listen()).ok).toBe(true);
    return p;
  }

  function start(
    endpoint: string | undefined,
    token: string | undefined,
    preload?: string,
    envEndpoint?: string,
  ): Shim {
    const s = runShim(endpoint, token, preload, envEndpoint);
    children.push(s.child);
    return s;
  }

  it('hello carries the env token', async () => {
    const conns: EndpointConnection[] = [];
    const p = await host((c) => conns.push(c));
    start(p, 'abc');
    await expect.poll(() => conns.length, { timeout: 10_000 }).toBe(1);
    expect(conns[0]?.token).toBe('abc');
  });

  it('uses the endpoint env var when --endpoint is absent', async () => {
    const conns: EndpointConnection[] = [];
    const p = await host((c) => conns.push(c));
    start(undefined, 'abc', undefined, p);
    await expect.poll(() => conns.length, { timeout: 10_000 }).toBe(1);
    expect(conns[0]?.token).toBe('abc');
  });

  it('treats a literal endpoint placeholder as absent and exits on stdin end', async () => {
    const s = start(undefined, undefined, undefined, '${env:CONDUIT_MCP_ENDPOINT}');
    s.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(JSON.parse(await s.nextLine())).toMatchObject({
      id: 1,
      result: { capabilities: { tools: {} } },
    });
    s.child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    expect(JSON.parse(await s.nextLine())).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [] },
    });
    s.child.stdin.end();
    expect(await s.exit).toBe(0);
  });

  it('sends a null token for a literal token placeholder', async () => {
    const conns: EndpointConnection[] = [];
    const p = await host((c) => conns.push(c));
    start(p, '${env:CONDUIT_SESSION_TOKEN}');
    await expect.poll(() => conns.length, { timeout: 10_000 }).toBe(1);
    expect(conns[0]?.token).toBeNull();
  });

  it('no token → hello token null', async () => {
    const conns: EndpointConnection[] = [];
    const p = await host((c) => conns.push(c));
    start(p, undefined);
    await expect.poll(() => conns.length, { timeout: 10_000 }).toBe(1);
    expect(conns[0]?.token).toBeNull();
  });

  it('bytes relay both ways unchanged', async () => {
    const p = await host((c) => c.onLine((l) => c.send(l)));
    const s = start(p, 't');
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'x',
      params: { s: `é✓${'a'.repeat(200 * 1024)}` },
    });
    s.child.stdin.write(`${big}\n`);
    expect(await s.nextLine()).toBe(big);
  });

  it('stdin written before connect is delivered after hello', async () => {
    const got: string[] = [];
    const p = await host((c) => c.onLine((l) => got.push(l)));
    const s = start(p, 't', delayedConnectPreload());
    // The preload holds the connect back, so this line is read while the shim is still connecting.
    s.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await expect
      .poll(() => got, { timeout: 10_000 })
      .toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
  });

  it('host down → initialize answered, tools/list [], tools/call host_unavailable', async () => {
    const s = start(testEndpoint(), 't');
    s.child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n',
    );
    const init = JSON.parse(await s.nextLine());
    expect(init).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'conduit' },
      },
    });
    s.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    s.child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    expect(JSON.parse(await s.nextLine())).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [] },
    });
    s.child.stdin.write(
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sessions"}}\n',
    );
    const call = JSON.parse(await s.nextLine());
    expect(call.id).toBe(3);
    expect(call.result.isError).toBe(true);
    expect(JSON.parse(call.result.content[0].text).error).toMatchObject({
      code: 'host_unavailable',
      retryable: true,
    });
    s.child.stdin.write('{"jsonrpc":"2.0","id":"x","method":"server/discover"}\n');
    expect(JSON.parse(await s.nextLine())).toMatchObject({ id: 'x', error: { code: -32601 } });
  });

  it('host closing the connection switches to the fallback', async () => {
    const p = await host((c) => c.onLine(() => c.close()));
    const s = start(p, 't');
    s.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    // Lines relayed before the shim sees the close are lost with the connection, and a shim slow
    // to start (a loaded machine) is still relaying long after a fixed wait: ask until answered.
    const first = s.nextLine();
    let id = 1;
    const ask = setInterval(() => {
      id += 1;
      s.child.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":"tools/list"}\n`);
    }, 200);
    try {
      expect(JSON.parse(await first)).toMatchObject({ jsonrpc: '2.0', result: { tools: [] } });
    } finally {
      clearInterval(ask);
    }
  });

  it('stdin end → exit 0 (host up and host down)', async () => {
    const p = await host(() => undefined);
    const up = start(p, 't');
    await new Promise((r) => setTimeout(r, 200));
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
