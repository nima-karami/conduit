import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditSink } from '../../server/network/audit-log';
import { listenStdioLink } from '../../server/network/stdio-link-endpoint';
import type { BridgePreamble } from '../../src/contracts/ssh-link';
import { encodeFrame } from '../../src/network/frame-codec';

const SECRET = 'correct-secret';
const quiet = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanup.splice(0).reverse()) await c();
});

function endpointName(): string {
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\conduit-link-test-${Date.now()}-${Math.random()}`;
  const dir = mkdtempSync(join(tmpdir(), 'sle-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'l.sock');
}

function preamble(secret: string): Buffer {
  const frame: BridgePreamble = { t: 'bridge', v: 1, secret };
  return encodeFrame(frame);
}

function audit() {
  const events: AuditEvent[] = [];
  const sink: AuditSink = { record: (e) => events.push(e) };
  return { events, sink };
}

async function listen(overrides: { accept?: (s: Duplex) => void } = {}) {
  const endpoint = endpointName();
  const a = audit();
  const accepted: Duplex[] = [];
  const server = await listenStdioLink({
    endpoint,
    platform: process.platform,
    secret: () => SECRET,
    accept: overrides.accept ?? ((s) => accepted.push(s)),
    audit: a.sink,
    log: quiet,
  });
  cleanup.push(() => server.close());
  return { endpoint, server, audit: a, accepted };
}

function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(endpoint);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
    cleanup.push(() => {
      sock.destroy();
    });
  });
}

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('listenStdioLink', () => {
  it('a good preamble hands over the socket with the following bytes intact', async () => {
    const { endpoint, accepted } = await listen();
    const client = await connect(endpoint);
    const ping = encodeFrame({ t: 'ping' });
    client.write(Buffer.concat([preamble(SECRET), ping]));

    await until(() => accepted.length === 1);
    const received: Buffer[] = [];
    // The stream comes paused, as the link listener's sockets do; the consumer resumes it.
    accepted[0]?.on('data', (chunk: Buffer) => received.push(chunk));
    accepted[0]?.resume();
    await until(() => Buffer.concat(received).length >= ping.length);
    expect(Buffer.concat(received)).toEqual(ping);
  });

  it('a wrong secret is audited and closed', async () => {
    const { endpoint, audit: a, accepted } = await listen();
    const client = await connect(endpoint);
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.write(preamble('wrong-secret'));

    await closed;
    expect(accepted).toHaveLength(0);
    expect(a.events).toEqual([
      { kind: 'bridge.refused', peer: null, detail: { reason: 'bad_secret' } },
    ]);
  });

  it('an oversize frame is bad_preamble', async () => {
    const { endpoint, audit: a, accepted } = await listen();
    const client = await connect(endpoint);
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(1025, 0);
    client.write(Buffer.concat([prefix, Buffer.alloc(16)]));

    await closed;
    expect(accepted).toHaveLength(0);
    expect(a.events).toEqual([
      { kind: 'bridge.refused', peer: null, detail: { reason: 'bad_preamble' } },
    ]);
  });

  it('silence is timeout', async () => {
    // Fake before the accept, so the server's 5 s timer is one this test can fire. Only setTimeout
    // is faked: the accept itself is I/O, and waits below use setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { endpoint, audit: a, accepted } = await listen();
    const client = await connect(endpoint);
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    for (let i = 0; i < 200 && a.events.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(5_000);
    }

    await closed;
    expect(accepted).toHaveLength(0);
    expect(a.events).toEqual([
      { kind: 'bridge.refused', peer: null, detail: { reason: 'timeout' } },
    ]);
  });
});
