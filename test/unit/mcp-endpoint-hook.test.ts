import { createHash } from 'node:crypto';
import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShimEndpoint } from '../../server/mcp/endpoint';
import type { EndpointConnection, McpEndpoint } from '../../src/conduit-mcp/host';
import type { HookPost } from '../../src/contracts/hook-protocol';
import { HOOK_POST_MAX_BYTES } from '../../src/contracts/hook-protocol';
import type { TokenRows } from '../../src/contracts/server-ports';
import type { TokenRecord } from '../../src/contracts/session-identity';
import { onLines } from '../helpers/line-socket';
import { testEndpoint } from '../helpers/test-endpoint';

const TOKEN = 'tok_3f9a1c';
const ACK_OK = '{"conduitHook":1,"ok":true}';
const ACK_REFUSED = '{"conduitHook":1,"ok":false}';

const row = (token: string, state: TokenRecord['state'] = 'live'): TokenRecord => ({
  sessionId: 's1',
  sha256: createHash('sha256').update(token).digest('hex'),
  generation: 1,
  launchId: 'a'.repeat(32),
  state,
  hcAddress: 'hc:1',
  createdAt: '2026-11-13T00:00:00.000Z',
});
const live = (): TokenRows => ({ state: 'loaded', rows: [row(TOKEN)] });

const hookLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    conduitHook: 1,
    token: TOKEN,
    event: 'StopFailure',
    payload: { error: 'rate_limit' },
    ...over,
  });

const endpoints: McpEndpoint[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  drops.length = 0;
  for (const s of sockets.splice(0)) s.destroy();
  for (const e of endpoints.splice(0)) await e.close();
});

const drops: string[] = [];
const dropLog = {
  debug: (_scope: string, message: string, data?: Record<string, unknown>) => {
    if (message === 'endpoint connection dropped') drops.push(String(data?.why));
  },
  warn: () => undefined,
};

async function serve(rows: () => TokenRows) {
  const p = testEndpoint();
  const onHook = vi.fn((_sessionId: string, _post: HookPost) => undefined);
  const conns: EndpointConnection[] = [];
  const ep = createShimEndpoint({
    path: p,
    log: dropLog,
    tokens: { rows },
    onHook,
    onConnection: (c) => {
      conns.push(c);
    },
  });
  endpoints.push(ep);
  expect((await ep.listen()).ok).toBe(true);
  return { p, onHook, conns };
}

function dial(p: string) {
  const socket = net.connect(p);
  sockets.push(socket);
  const got: string[] = [];
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => resolve());
  });
  socket.on('error', () => undefined);
  onLines(socket, (l) => got.push(l));
  return { write: (l: string) => socket.write(`${l}\n`), got, closed };
}

describe('hook posts on the MCP endpoint', () => {
  it('a known token → onHook with its session and the post, then an ok ack and close', async () => {
    const { p, onHook } = await serve(live);
    const d = dial(p);
    d.write(hookLine());
    await d.closed;
    expect(d.got).toEqual([ACK_OK]);
    expect(onHook).toHaveBeenCalledTimes(1);
    expect(onHook).toHaveBeenCalledWith('s1', {
      conduitHook: 1,
      token: TOKEN,
      event: 'StopFailure',
      payload: { error: 'rate_limit' },
    });
  });

  it('an unknown token → ok:false, no onHook', async () => {
    const { p, onHook } = await serve(live);
    const d = dial(p);
    d.write(hookLine({ token: 'tok_someone_else' }));
    await d.closed;
    expect(d.got).toEqual([ACK_REFUSED]);
    expect(onHook).not.toHaveBeenCalled();
  });

  it('a superseded token → ok:false, no onHook', async () => {
    const { p, onHook } = await serve(() => ({
      state: 'loaded',
      rows: [row(TOKEN, 'superseded')],
    }));
    const d = dial(p);
    d.write(hookLine());
    await d.closed;
    expect(d.got).toEqual([ACK_REFUSED]);
    expect(onHook).not.toHaveBeenCalled();
  });

  it('a draining store (unreadable) → ok:false, no onHook', async () => {
    const { p, onHook } = await serve(() => ({ state: 'unreadable' }));
    const d = dial(p);
    d.write(hookLine());
    await d.closed;
    expect(d.got).toEqual([ACK_REFUSED]);
    expect(onHook).not.toHaveBeenCalled();
  });

  it('a post with no token, or an unknown event → ok:false, no onHook', async () => {
    const { p, onHook } = await serve(live);
    const noToken = dial(p);
    noToken.write(hookLine({ token: undefined }));
    await noToken.closed;
    const badEvent = dial(p);
    badEvent.write(hookLine({ event: 'Bogus' }));
    await badEvent.closed;
    expect(noToken.got).toEqual([ACK_REFUSED]);
    expect(badEvent.got).toEqual([ACK_REFUSED]);
    expect(onHook).not.toHaveBeenCalled();
  });

  it('an oversized hook line closes without an ack or onHook', async () => {
    const { p, onHook } = await serve(live);
    const d = dial(p);
    d.write(hookLine({ payload: 'x'.repeat(HOOK_POST_MAX_BYTES) }));
    await d.closed;
    expect(d.got).toEqual([]);
    expect(onHook).not.toHaveBeenCalled();
    expect(drops.at(-1)).toBe('hook post too large');
  });

  it('a normal C6 hello still gets its welcome and never reaches onHook', async () => {
    const { p, onHook, conns } = await serve(live);
    const d = dial(p);
    d.write(JSON.stringify({ conduit: 2, token: TOKEN, shim: 'test', resume: null }));
    await vi.waitFor(() => expect(d.got).toHaveLength(1));
    expect(d.got).toEqual(['{"conduit":2,"ok":true}']);
    expect(conns).toHaveLength(1);
    expect(onHook).not.toHaveBeenCalled();
  });

  it('a C6 hello over the 64 KiB hello limit is still refused', async () => {
    const { p, conns } = await serve(live);
    const d = dial(p);
    d.write(JSON.stringify({ conduit: 2, token: TOKEN, shim: 'x'.repeat(70_000), resume: null }));
    await d.closed;
    expect(d.got).toEqual([]);
    expect(conns).toHaveLength(0);
  });

  it('a hook post with leading whitespace is still a hook post', async () => {
    const { p, onHook } = await serve(live);
    const d = dial(p);
    d.write(`  \t${hookLine()}`);
    await d.closed;
    expect(d.got).toEqual([ACK_OK]);
    expect(onHook).toHaveBeenCalledTimes(1);
  });

  it('a hook post over 64 KiB and under the hook cap is still acked', async () => {
    const { p, onHook } = await serve(live);
    const d = dial(p);
    d.write(hookLine({ payload: 'x'.repeat(100_000) }));
    await d.closed;
    expect(d.got).toEqual([ACK_OK]);
    expect(onHook).toHaveBeenCalledTimes(1);
  });

  it('a prefix that ends past 64 KiB is capped as a hello, even under 64 KiB of whitespace', async () => {
    const { p, onHook } = await serve(live);
    const d = dial(p);
    d.write(`${' '.repeat(65_530)}${hookLine()}`);
    await d.closed;
    expect(d.got).toEqual([]);
    expect(onHook).not.toHaveBeenCalled();
    expect(drops.at(-1)).toBe('hello too large');
  });

  it('whitespace past 64 KiB before the hook prefix is capped as a hello', async () => {
    const { p, onHook } = await serve(live);
    const d = dial(p);
    d.write(`${' '.repeat(70_000)}${hookLine()}`);
    await d.closed;
    expect(d.got).toEqual([]);
    expect(onHook).not.toHaveBeenCalled();
    expect(drops.at(-1)).toBe('hello too large');
  });

  it('a C6 hello over 64 KiB is refused as too large, with or without leading whitespace', async () => {
    for (const lead of ['', '  ']) {
      const { p } = await serve(live);
      const d = dial(p);
      d.write(
        `${lead}${JSON.stringify({ conduit: 2, token: TOKEN, shim: 'x'.repeat(70_000), resume: null })}`,
      );
      await d.closed;
      expect(d.got).toEqual([]);
      expect(drops.at(-1)).toBe('hello too large');
    }
  });
});
