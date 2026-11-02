import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShimEndpoint } from '../../server/mcp/endpoint';
import type { EndpointConnection, McpEndpoint } from '../../src/conduit-mcp/host';
import type { TokenRows } from '../../src/contracts/server-ports';
import type { TokenRecord } from '../../src/contracts/session-identity';
import { RESUME_NOTIFICATION } from '../../src/contracts/shim-protocol';
import { onLines } from '../helpers/line-socket';
import { testEndpoint } from '../helpers/test-endpoint';

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'contracts', 'shim-hello.json'), 'utf8'),
) as {
  valid: { name: string; line: string }[];
  invalid: { name: string; line: string }[];
  unsupported: { name: string; line: string }[];
};
const line = (name: string) => {
  const hit = FIXTURES.valid.find((f) => f.name === name);
  if (!hit) throw new Error(name);
  return hit.line;
};

const noLog = { debug: () => undefined, warn: () => undefined };
const row = (token: string, state: TokenRecord['state'] = 'live'): TokenRecord => ({
  sessionId: 's1',
  sha256: createHash('sha256').update(token).digest('hex'),
  generation: 1,
  launchId: 'a'.repeat(32),
  state,
  hcAddress: 'hc:1',
  createdAt: '2026-11-02T00:00:00.000Z',
});

const endpoints: McpEndpoint[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const e of endpoints.splice(0)) await e.close();
});

/** A host that answers initialize and ping and records every line it reads. */
async function serve(rows: () => TokenRows) {
  const p = testEndpoint();
  const conns: Array<{ conn: EndpointConnection; lines: string[] }> = [];
  const ep = createShimEndpoint({
    path: p,
    log: noLog,
    tokens: { rows },
    onConnection: (conn) => {
      const lines: string[] = [];
      conns.push({ conn, lines });
      conn.onLine((l) => {
        lines.push(l);
        const msg = JSON.parse(l);
        if (msg.id !== undefined && (msg.method === 'initialize' || msg.method === 'ping'))
          conn.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { m: msg.method } }));
      });
    },
  });
  endpoints.push(ep);
  expect((await ep.listen()).ok).toBe(true);
  return { p, conns };
}

function dial(p: string) {
  const socket = net.connect(p);
  sockets.push(socket);
  const got: string[] = [];
  let closed = false;
  onLines(socket, (l) => got.push(l));
  socket.on('error', () => undefined);
  socket.on('close', () => {
    closed = true;
  });
  return {
    write: (l: string) => socket.write(`${l}\n`),
    got,
    closed: () => closed,
  };
}

const live = (): TokenRows => ({ state: 'loaded', rows: [row('tok_3f9a1c')] });

describe('C6 endpoint: hello and welcome', () => {
  it('welcomes a valid gen-2 hello and hands the host its token', async () => {
    const { p, conns } = await serve(live);
    const c = dial(p);
    c.write(line('gen-2 hello'));
    await expect.poll(() => c.got).toEqual(['{"conduit":2,"ok":true}']);
    expect(conns.map((x) => x.conn.token)).toEqual(['tok_3f9a1c']);
  });

  it('accepts a tokenless gen-2 hello with no tools, as in v0.51', async () => {
    const { p, conns } = await serve(live);
    const c = dial(p);
    c.write(line('gen-2 tokenless'));
    await expect.poll(() => c.got).toEqual(['{"conduit":2,"ok":true}']);
    expect(conns[0]?.conn.token).toBeNull();
  });

  it('answers a gen-1 hello with no welcome at all', async () => {
    const { p, conns } = await serve(live);
    const c = dial(p);
    c.write(line('gen-1 v0.51 hello'));
    await expect.poll(() => conns.length).toBe(1);
    c.write('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await expect.poll(() => c.got).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"m":"ping"}}']);
  });

  it.each(FIXTURES.invalid)('drops an invalid hello: $name', async ({ line: l }) => {
    const { p, conns } = await serve(live);
    const c = dial(p);
    c.write(l);
    await expect.poll(() => c.closed()).toBe(true);
    expect(c.got).toEqual([]);
    expect(conns).toEqual([]);
  });

  it.each(FIXTURES.unsupported)(
    'a newer generation gets unsupported_generation: $name',
    async ({ line: l }) => {
      const { p, conns } = await serve(live);
      const c = dial(p);
      c.write(l);
      await expect.poll(() => c.closed()).toBe(true);
      expect(c.got).toEqual(['{"conduit":2,"ok":false,"reason":"unsupported_generation"}']);
      expect(conns).toEqual([]);
    },
  );

  it('an unknown or superseded token gets unknown_token after a clean load', async () => {
    let rows: TokenRows = { state: 'loaded', rows: [] };
    const { p, conns } = await serve(() => rows);
    const a = dial(p);
    a.write(line('gen-2 hello'));
    await expect.poll(() => a.closed()).toBe(true);
    expect(a.got).toEqual(['{"conduit":2,"ok":false,"reason":"unknown_token"}']);
    rows = { state: 'loaded', rows: [row('tok_3f9a1c', 'superseded')] };
    const b = dial(p);
    b.write(line('gen-2 hello'));
    await expect.poll(() => b.closed()).toBe(true);
    expect(b.got).toEqual(['{"conduit":2,"ok":false,"reason":"unknown_token"}']);
    expect(conns).toEqual([]);
  });

  it('welcomes every hello with draining while the store is unreadable', async () => {
    const { p, conns } = await serve(() => ({ state: 'unreadable' }));
    for (const name of ['gen-2 hello', 'gen-2 tokenless', 'gen-2 resume']) {
      const c = dial(p);
      c.write(line(name));
      await expect.poll(() => c.closed()).toBe(true);
      expect(c.got).toEqual(['{"conduit":2,"ok":false,"reason":"draining"}']);
    }
    expect(conns).toEqual([]);
  });

  it('drains a token hello while the store file is missing: it may only be lost', async () => {
    const { p } = await serve(() => ({ state: 'missing' }));
    const c = dial(p);
    c.write(line('gen-2 hello'));
    await expect.poll(() => c.got).toEqual(['{"conduit":2,"ok":false,"reason":"draining"}']);
  });
});

describe('C6 endpoint: resume', () => {
  const initParams = JSON.parse(line('gen-2 resume')).resume.initialize;

  it('resume initialized:true replays the cached initialize, never answers it, then list_changed', async () => {
    const { p, conns } = await serve(live);
    const c = dial(p);
    c.write(line('gen-2 resume'));
    await expect
      .poll(() => c.got)
      .toEqual([
        '{"conduit":2,"ok":true}',
        JSON.stringify({ jsonrpc: '2.0', method: RESUME_NOTIFICATION }),
      ]);
    const replayed = JSON.parse(conns[0]?.lines[0] ?? 'null');
    expect(replayed).toMatchObject({ method: 'initialize', params: initParams });
    // The connection keeps working for the client's own requests.
    c.write('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await expect.poll(() => c.got.length).toBe(3);
    expect(JSON.parse(c.got[2] ?? '')).toMatchObject({ id: 1, result: { m: 'ping' } });
    expect(c.got.filter((l) => l.includes('"initialize"'))).toEqual([]);
  });

  it('resume initialized:false waits for notifications/initialized before initializing', async () => {
    const { p, conns } = await serve(live);
    const c = dial(p);
    const hello = JSON.parse(line('gen-2 resume'));
    hello.resume.initialized = false;
    c.write(JSON.stringify(hello));
    await expect.poll(() => c.got).toEqual(['{"conduit":2,"ok":true}']);
    c.write('{"jsonrpc":"2.0","id":7,"method":"ping"}');
    await expect.poll(() => c.got.length).toBe(2);
    // Not initialized yet: only the client's own line reached the host.
    expect(conns[0]?.lines.map((l) => JSON.parse(l).method)).toEqual(['ping']);
    c.write('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    await expect.poll(() => c.got.length).toBe(3);
    expect(c.got[2]).toBe(JSON.stringify({ jsonrpc: '2.0', method: RESUME_NOTIFICATION }));
    expect(conns[0]?.lines.map((l) => JSON.parse(l).method)).toEqual([
      'ping',
      'initialize',
      'notifications/initialized',
    ]);
  });
});
