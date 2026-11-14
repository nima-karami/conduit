import type tls from 'node:tls';
import {
  type HelloFrame,
  LINK_DOWN_MS,
  LINK_FRAME_MAX_BYTES,
  LINK_PING_MS,
  type LinkFrame,
  parseLinkFrame,
} from '../../src/contracts/link-protocol';
import { encodeFrame, FrameDecoder } from '../../src/network/frame-codec';
import type { NetLog } from './listener';

// One authenticated link connection: the socket arrives already pinned (listener.ts), so this only
// frames, says hello, keeps the link alive and hands frames up. Plan decision 7.

const SEND_BUFFER_MAX = 4 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;

export interface LinkConnection {
  /** False once the socket holds more than 4 MiB unsent: the caller sheds load (pane relay). */
  send(frame: LinkFrame): boolean;
  bufferedBytes(): number;
  /** Milliseconds since the peer last sent anything; the manager shows `degraded` from it. */
  silentMs(): number;
  close(reason: string): void;
  readonly peerHello: HelloFrame;
}

export interface ConnectionOptions {
  hello: HelloFrame;
  onFrame(frame: LinkFrame): void;
  onClose(why: string): void;
  now(): number;
  log: NetLog;
  pingMs?: number;
  downMs?: number;
  helloTimeoutMs?: number;
  /** Repeats fn every ms; returns its cancel. Injected by tests to drive time. */
  every?: (fn: () => void, ms: number) => () => void;
}

const realEvery = (fn: () => void, ms: number): (() => void) => {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle);
};

export type ConnectionError = 'incompatible' | 'bad-hello' | 'timeout' | 'closed';

export function openConnection(
  sock: tls.TLSSocket,
  opts: ConnectionOptions,
): Promise<LinkConnection | { error: ConnectionError; peerHello?: HelloFrame }> {
  const decoder = new FrameDecoder(LINK_FRAME_MAX_BYTES);
  const every = opts.every ?? realEvery;
  const pingMs = opts.pingMs ?? LINK_PING_MS;
  const downMs = opts.downMs ?? LINK_DOWN_MS;
  let lastFrameAt = opts.now();
  let closed = false;
  let cancelTicker: (() => void) | null = null;
  let peerHello: HelloFrame | null = null;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: LinkConnection | { error: ConnectionError; peerHello?: HelloFrame }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const finish = (why: string): void => {
      if (closed) return;
      closed = true;
      cancelTicker?.();
      sock.destroy();
      if (peerHello === null) settle({ error: why === 'timeout' ? 'timeout' : 'closed' });
      else opts.onClose(why);
    };
    const write = (frame: LinkFrame): boolean => {
      if (closed) return false;
      sock.write(encodeFrame(frame));
      return sock.writableLength <= SEND_BUFFER_MAX;
    };
    const helloTimer = setTimeout(() => finish('timeout'), opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    const connection = (hello: HelloFrame): LinkConnection => ({
      send: write,
      bufferedBytes: () => sock.writableLength,
      silentMs: () => opts.now() - lastFrameAt,
      close: (reason) => finish(reason),
      peerHello: hello,
    });

    const onHello = (frame: LinkFrame | null): void => {
      clearTimeout(helloTimer);
      if (frame?.t !== 'hello') {
        settle({ error: 'bad-hello' });
        finish('bad-hello');
        return;
      }
      if (frame.protocol.major !== opts.hello.protocol.major) {
        write({ t: 'bye', reason: 'incompatible' });
        settle({ error: 'incompatible', peerHello: frame });
        finish('incompatible');
        return;
      }
      peerHello = frame;
      cancelTicker = every(() => {
        if (opts.now() - lastFrameAt >= downMs) finish('silence');
        else write({ t: 'ping' });
      }, pingMs);
      settle(connection(frame));
    };

    sock.on('data', (chunk: Buffer) => {
      lastFrameAt = opts.now();
      const { frames, error } = decoder.push(chunk);
      for (const raw of frames) {
        if (closed) return;
        const frame = parseLinkFrame(raw);
        if (peerHello === null) {
          onHello(frame);
          continue;
        }
        if (frame === null) {
          // A frame this version doesn't know: a newer minor peer may send one; skipping keeps
          // the link up, and the features exchanged in hello stop it relying on the reply.
          opts.log.debug('link: unknown frame ignored', {});
          continue;
        }
        if (frame.t === 'ping') write({ t: 'pong' });
        else if (frame.t !== 'pong') opts.onFrame(frame);
      }
      if (error !== null) {
        opts.log.warn('link: framing error', { error });
        finish(error);
      }
    });
    sock.on('close', () => finish('closed'));
    sock.on('error', (err) => {
      opts.log.debug('link: socket error', { message: err.message });
      finish('error');
    });
    write(opts.hello);
    sock.resume();
  });
}
