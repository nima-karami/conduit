import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runLinkStdioBridge } from '../../server/lifecycle/link-stdio-bridge';
import { writeLinkEndpoint, writeServerSecret } from '../../server/lifecycle/server-secret';
import { listenStdioLink, type StdioLinkEndpoint } from '../../server/network/stdio-link-endpoint';

const quiet = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sinks() {
  let out = '';
  let err = '';
  const stdout = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out += chunk.toString('utf8');
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk: Buffer, _enc, cb) {
      err += chunk.toString('utf8');
      cb();
    },
  });
  return { stdout, stderr, out: () => out, err: () => err };
}

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('runLinkStdioBridge', () => {
  it('pipes bytes both ways after the preamble', async () => {
    const dir = userData();
    const secret = writeServerSecret(dir);
    // The server records the endpoint it listens on; the bridge reads that instead of deriving one.
    const endpoint = join(dir, 'conduit-link.sock');
    writeLinkEndpoint(dir, endpoint);
    const heard: Buffer[] = [];
    const listened: StdioLinkEndpoint = await listenStdioLink({
      endpoint,
      platform: process.platform,
      secret: () => secret,
      accept: (stream: Duplex) => {
        stream.on('data', (chunk: Buffer) => heard.push(chunk));
        stream.resume();
        stream.write('from-server');
      },
      audit: { record: () => undefined },
      log: quiet,
    });
    cleanup.push(() => listened.close());

    const stdin = new PassThrough();
    const io = sinks();
    const done = runLinkStdioBridge({ userData: dir, stdin, stdout: io.stdout, stderr: io.stderr });
    stdin.write('from-controller');

    await until(() => Buffer.concat(heard).toString('utf8') === 'from-controller');
    await until(() => io.out() === 'from-server');
    stdin.end();
    expect(await done).toBe(0);
    expect(io.out()).toBe('from-server');
    expect(io.err()).toBe('');
  });

  it('no secret file → exit 3 + line', async () => {
    const dir = userData();
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_secret\n');
    expect(io.out()).toBe('');
  });

  it('no endpoint file → exit 3 + no_server, without guessing a path', async () => {
    const dir = userData();
    writeServerSecret(dir);
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_server\n');
    expect(io.out()).toBe('');
  });

  it('a recorded endpoint with nothing listening → exit 3 + no_server', async () => {
    const dir = userData();
    writeServerSecret(dir);
    writeLinkEndpoint(dir, join(dir, 'gone.sock'));
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_server\n');
  });

  it('an endpoint that closes before any byte comes back is refused', async () => {
    const dir = userData();
    writeServerSecret(dir);
    writeLinkEndpoint(dir, join(dir, 'conduit-link.sock'));
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
      // Reads end at once and nothing is ever written back: the endpoint closed unanswered.
      connect: () =>
        new Duplex({
          read() {
            this.push(null);
          },
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: refused\n');
  });
  it('an empty endpoint record → exit 3 + no_server', async () => {
    const dir = userData();
    writeServerSecret(dir);
    writeLinkEndpoint(dir, '');
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_server\n');
  });

  it('an empty secret → exit 3 + no_secret', async () => {
    const dir = userData();
    writeFileSync(join(dir, 'server-secret'), '');
    writeLinkEndpoint(dir, join(dir, 'conduit-link.sock'));
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_secret\n');
  });

  it('a numeric endpoint record never dials TCP', async () => {
    const dir = userData();
    writeServerSecret(dir);
    let tcpPeers = 0;
    const tcp = createServer(() => {
      tcpPeers += 1;
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', () => resolve()));
    cleanup.push(() => new Promise<void>((resolve) => tcp.close(() => resolve())));
    const port = (tcp.address() as AddressInfo).port;
    writeLinkEndpoint(dir, String(port));
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_server\n');
    expect(tcpPeers).toBe(0);
  });

  it('an EPIPE on stdout ends the bridge with 0 instead of crashing', async () => {
    const dir = userData();
    writeServerSecret(dir);
    writeLinkEndpoint(dir, join(dir, 'conduit-link.sock'));
    let pushed = false;
    // The endpoint sends bytes and never ends, so only the broken stdout can end the bridge.
    const io = sinks();
    const brokenStdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const code = await runLinkStdioBridge({
      userData: dir,
      stdin: new PassThrough(),
      stdout: brokenStdout,
      stderr: io.stderr,
      connect: () =>
        new Duplex({
          read() {
            if (!pushed) {
              pushed = true;
              this.push(Buffer.from('link bytes'));
            }
          },
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
    });
    expect(code).toBe(0);
  });
});
