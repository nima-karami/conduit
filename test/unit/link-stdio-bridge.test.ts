import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runLinkStdioBridge } from '../../server/lifecycle/link-stdio-bridge';
import { writeServerSecret } from '../../server/lifecycle/server-secret';
import { listenStdioLink, type StdioLinkEndpoint } from '../../server/network/stdio-link-endpoint';
import { linkEndpointOf } from '../../src/instance-names';

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
    const platform = process.platform;
    const endpoint = linkEndpointOf(dir, platform, tmpdir());
    const heard: Buffer[] = [];
    const audit = { record: () => undefined };
    const listened: StdioLinkEndpoint = await listenStdioLink({
      endpoint,
      platform,
      secret: () => secret,
      accept: (stream) => {
        stream.on('data', (chunk: Buffer) => heard.push(chunk));
        stream.resume();
        stream.write('from-server');
      },
      audit,
      log: quiet,
    });
    cleanup.push(() => listened.close());

    const stdin = new PassThrough();
    const io = sinks();
    const done = runLinkStdioBridge({
      userData: dir,
      platform,
      stdin,
      stdout: io.stdout,
      stderr: io.stderr,
    });
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
      platform: process.platform,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_secret\n');
    expect(io.out()).toBe('');
  });

  it('no server → exit 3 + line', async () => {
    const dir = userData();
    writeServerSecret(dir);
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      platform: process.platform,
      stdin: new PassThrough(),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3);
    expect(io.err()).toBe('conduit-bridge: no_server\n');
    expect(io.out()).toBe('');
  });

  it('an endpoint that closes before any byte comes back is refused', async () => {
    const dir = userData();
    writeServerSecret(dir);
    const io = sinks();
    const code = await runLinkStdioBridge({
      userData: dir,
      platform: process.platform,
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
});
