import * as fs from 'node:fs';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMcpEndpoint,
  type EndpointConnection,
  HELLO_MAX_BYTES,
  INBOUND_LINE_MAX_BYTES,
  type McpEndpoint,
} from '../../electron/conduit-mcp-endpoint';
import { endpointPath } from '../../src/conduit-mcp/endpoint-path';
import { testEndpoint } from '../helpers/test-endpoint';

describe('endpointPath', () => {
  it('win32: case-insensitive userData gives the same pipe name', () => {
    const a = endpointPath('C:/Users/A/AppData/Roaming/Conduit', 'win32', '/tmp');
    const b = endpointPath('c:/users/a/appdata/roaming/conduit', 'win32', '/tmp');
    expect(a).toBe(b);
    expect(a.startsWith('\\\\.\\pipe\\conduit-mcp-')).toBe(true);
    expect(a).toMatch(/^\\\\\.\\pipe\\conduit-mcp-[0-9a-f]{16}$/);
  });

  it('posix: socket in userData, or the tmpdir form when too long', () => {
    expect(endpointPath('/home/a/.config/Conduit', 'posix', '/tmp')).toBe(
      '/home/a/.config/Conduit/conduit-mcp/mcp.sock',
    );
    const long = `/home/${'x'.repeat(114)}`;
    expect(long).toHaveLength(120);
    expect(endpointPath(long, 'posix', '/tmp')).toMatch(/^\/tmp\/conduit-mcp-[0-9a-f]{16}\.sock$/);
  });

  it('dev and installed userData differ', () => {
    const installed = endpointPath('C:/Users/A/AppData/Roaming/Conduit', 'win32', '/tmp');
    const dev = endpointPath('C:/Users/A/AppData/Roaming/Conduit Dev', 'win32', '/tmp');
    expect(installed).not.toBe(dev);
    expect(endpointPath('/home/a/x', 'posix', '/tmp')).not.toBe(
      endpointPath('/home/a/y', 'posix', '/tmp'),
    );
  });
});

const noLog = { debug: () => undefined, warn: () => undefined };

describe('createMcpEndpoint', () => {
  let ep: McpEndpoint | undefined;
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await ep?.close();
    ep = undefined;
  });

  async function serve(
    onConnection: (c: EndpointConnection) => void,
    path = testEndpoint(),
    closeFlushMs?: number,
  ) {
    ep = createMcpEndpoint({ path, onConnection, log: noLog, closeFlushMs });
    const r = await ep.listen();
    expect(r.ok).toBe(true);
    return path;
  }

  function dial(path: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(path, () => resolve(s));
      s.on('error', reject);
      sockets.push(s);
    });
  }

  const closed = (s: net.Socket) => new Promise<void>((resolve) => s.on('close', () => resolve()));

  function readLines(s: net.Socket): () => Promise<string> {
    let buf = '';
    const waiters: Array<(l: string) => void> = [];
    const queued: string[] = [];
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
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
    return () => {
      const q = queued.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((resolve) => waiters.push(resolve));
    };
  }

  it('hello token parsed; lines framed both ways; connection ids unique', async () => {
    const conns: EndpointConnection[] = [];
    const got: string[] = [];
    const path = await serve((c) => {
      conns.push(c);
      c.onLine((l) => {
        got.push(`${c.id}:${l}`);
        c.send(`echo ${l}`);
      });
    });
    const a = await dial(path);
    const nextA = readLines(a);
    a.write('{"conduit":1,"token":"abc"}\n{"x":1}\n{"y":"é');
    a.write('"}\n');
    expect(await nextA()).toBe('echo {"x":1}');
    expect(await nextA()).toBe('echo {"y":"é"}');
    const b = await dial(path);
    const nextB = readLines(b);
    b.write('{"conduit":1,"token":"  "}\nhi\n');
    expect(await nextB()).toBe('echo hi');
    expect(conns.map((c) => c.token)).toEqual(['abc', null]);
    expect(new Set(conns.map((c) => c.id)).size).toBe(2);
    expect(got).toEqual([
      `${conns[0]?.id}:{"x":1}`,
      `${conns[0]?.id}:{"y":"é"}`,
      `${conns[1]?.id}:hi`,
    ]);
  });

  it('a null token in the hello is accepted as no token', async () => {
    const conns: EndpointConnection[] = [];
    const path = await serve((c) => conns.push(c));
    const a = await dial(path);
    a.write('{"conduit":1,"token":null}\n');
    await expect.poll(() => conns.length).toBe(1);
    expect(conns[0]?.token).toBeNull();
  });

  it('no hello within the first line → closed', async () => {
    const conns: EndpointConnection[] = [];
    const path = await serve((c) => conns.push(c));
    const a = await dial(path);
    const done = closed(a);
    a.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    await done;
    expect(conns).toHaveLength(0);
  });

  it('oversized hello closed', async () => {
    const conns: EndpointConnection[] = [];
    const path = await serve((c) => conns.push(c));
    const a = await dial(path);
    const done = closed(a);
    a.on('error', () => undefined);
    a.write(`{"conduit":1,"token":"${'a'.repeat(HELLO_MAX_BYTES)}`);
    await done;
    expect(conns).toHaveLength(0);
  });

  it('oversized inbound line closes the connection', async () => {
    let closedSeen = false;
    const path = await serve((c) => c.onClose(() => (closedSeen = true)));
    const a = await dial(path);
    const done = closed(a);
    a.on('error', () => undefined);
    a.write('{"conduit":1,"token":"t"}\n');
    a.write('x'.repeat(INBOUND_LINE_MAX_BYTES + 1));
    await done;
    await expect.poll(() => closedSeen).toBe(true);
  });

  it('close() from the host ends the socket and fires onClose', async () => {
    let conn: EndpointConnection | undefined;
    let closedSeen = false;
    const path = await serve((c) => {
      conn = c;
      c.onClose(() => (closedSeen = true));
    });
    const a = await dial(path);
    const done = closed(a);
    a.write('{"conduit":1,"token":"t"}\n');
    await expect.poll(() => conn).toBeDefined();
    conn?.close();
    await done;
    await expect.poll(() => closedSeen).toBe(true);
  });

  it('close() to a peer that stops reading destroys the socket after the bound', async () => {
    let conn: EndpointConnection | undefined;
    let closedSeen = false;
    const path = await serve(
      (c) => {
        conn = c;
        c.onClose(() => (closedSeen = true));
      },
      testEndpoint(),
      200,
    );
    const a = await dial(path);
    let got = '';
    a.setEncoding('utf8');
    a.on('data', (d: string) => {
      got += d;
      // Reads the first reply, then never again.
      if (got.includes('\n')) a.pause();
    });
    a.write('{"conduit":1,"token":"t"}\n');
    await expect.poll(() => conn).toBeDefined();
    conn?.send('{"id":1}');
    await expect.poll(() => got).toBe('{"id":1}\n');
    const big = `{"pad":"${'x'.repeat(4 * 1024 * 1024)}"}`;
    for (let i = 0; i < 8; i++) conn?.send(big);
    conn?.close();
    await expect.poll(() => closedSeen, { timeout: 3_000 }).toBe(true);
    expect(got.startsWith('{"id":1}\n')).toBe(true);
  });

  it('close() right after several sends still delivers every line', async () => {
    let conn: EndpointConnection | undefined;
    const path = await serve((c) => {
      conn = c;
    });
    const a = await dial(path);
    let got = '';
    a.setEncoding('utf8');
    a.on('data', (d: string) => {
      got += d;
    });
    const done = closed(a);
    a.write('{"conduit":1,"token":"t"}\n');
    await expect.poll(() => conn).toBeDefined();
    const line = (n: number) => `{"id":${n},"pad":"${'x'.repeat(64 * 1024)}"}`;
    for (const n of [1, 2, 3]) conn?.send(line(n));
    conn?.close();
    await done;
    expect(got).toBe([1, 2, 3].map((n) => `${line(n)}\n`).join(''));
  });

  it('a second close() during the flush changes nothing', async () => {
    let conn: EndpointConnection | undefined;
    const path = await serve((c) => {
      conn = c;
    });
    const a = await dial(path);
    let got = '';
    a.setEncoding('utf8');
    a.on('data', (d: string) => {
      got += d;
    });
    const done = closed(a);
    a.write('{"conduit":1,"token":"t"}\n');
    await expect.poll(() => conn).toBeDefined();
    const line = (n: number) => `{"id":${n},"pad":"${'x'.repeat(64 * 1024)}"}`;
    for (const n of [1, 2, 3]) conn?.send(line(n));
    conn?.close();
    conn?.close();
    await done;
    expect(got).toBe([1, 2, 3].map((n) => `${line(n)}\n`).join(''));
  });

  it.skipIf(process.platform === 'win32')('stale posix socket file is unlinked', async () => {
    const path = testEndpoint();
    fs.writeFileSync(path, 'stale');
    const conns: EndpointConnection[] = [];
    await serve((c) => conns.push(c), path);
    const a = await dial(path);
    a.write('{"conduit":1,"token":"t"}\n');
    await expect.poll(() => conns.length).toBe(1);
  });
});
