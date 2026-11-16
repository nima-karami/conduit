import type { Duplex } from 'node:stream';
import {
  HELLO_PROOF_MIN_MINOR,
  type HelloFrame,
  LINK_DOWN_MS,
  LINK_FRAME_MAX_BYTES,
  LINK_PING_MS,
  type LinkFrame,
  parseLinkFrame,
} from '../../src/contracts/link-protocol';
import { encodeFrame, FrameDecoder } from '../../src/network/frame-codec';
import type { NetLog } from './listener';

// One authenticated link connection: the stream arrives already pinned (listener.ts for TLS, the
// ssh child's stdio for ssh), so this only frames, says hello, keeps the link alive and hands frames
// up. Plan decision 7. It takes a plain Duplex so the transport underneath is not its concern.

const SEND_BUFFER_MAX = 4 * 1024 * 1024;
/** Past this the peer is not reading at all; we close rather than buffer without bound (CON-27 R2b). */
const SEND_BUFFER_HARD_MAX = 16 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const END_GRACE_MS = 2_000;

export interface LinkConnection {
  /**
   * False once the socket holds more than 4 MiB unsent: the caller sheds load (pane relay). Past
   * 16 MiB the connection closes with reason 'overflow' and the frame is dropped.
   */
  send(frame: LinkFrame): boolean;
  bufferedBytes(): number;
  /** Milliseconds since the peer last sent anything; the manager shows `degraded` from it. */
  silentMs(): number;
  close(reason: string): void;
  /**
   * Begins delivery. Frames and a close that arrived before this are queued and handed over now,
   * so a frame sent right behind the hello (a revoked notice, say) can't slip past an owner that
   * was still deciding what to do with the connection.
   */
  start(handlers: { onFrame(frame: LinkFrame): void; onClose(why: string): void }): void;
  readonly peerHello: HelloFrame;
}

export interface ConnectionOptions {
  hello: HelloFrame;
  now(): number;
  log: NetLog;
  pingMs?: number;
  downMs?: number;
  helloTimeoutMs?: number;
  /** Repeats fn every ms; returns its cancel. Injected by tests to drive time. */
  every?: (fn: () => void, ms: number) => () => void;
  /** Set for an ssh link: the handshake is not complete until the peer proves its key. */
  proof?: HelloProof;
}

const realEvery = (fn: () => void, ms: number): (() => void) => {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle);
};

export type ConnectionError = 'incompatible' | 'bad-hello' | 'bad-proof' | 'timeout' | 'closed';

/**
 * An ssh link's proof of possession (plan F1). The peer's hello names a server key, and only a
 * signature from that key shows the peer holds it. TLS proves the same in its handshake, so only
 * ssh links set this.
 */
export interface HelloProof {
  /** Our signature over the peer's nonce, bound to both machine ids. */
  sign(peerNonce: string, peerMachineId: string): string;
  /** Whether `sig` is the peer's signature over our own nonce, for the key its hello named. */
  verify(peer: HelloFrame, sig: string): boolean;
}

export function openConnection(
  sock: Duplex,
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
  // An ssh link sits here between the peer's hello and its proof: nothing but the proof may arrive.
  let awaitingProof = false;
  let handlers: { onFrame(frame: LinkFrame): void; onClose(why: string): void } | null = null;
  const queued: LinkFrame[] = [];
  let closedWhy: string | null = null;
  const deliver = (frame: LinkFrame): void => {
    if (handlers) handlers.onFrame(frame);
    else queued.push(frame);
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: LinkConnection | { error: ConnectionError; peerHello?: HelloFrame }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    /** graceful: our own close, which lets frames already written (bye, revoked) reach the peer. */
    const finish = (why: string, graceful = false): void => {
      if (closed) return;
      closed = true;
      cancelTicker?.();
      if (graceful) {
        sock.end();
        // A peer that never reads must not hold the socket open forever.
        setTimeout(() => sock.destroy(), END_GRACE_MS).unref();
      } else sock.destroy();
      if (peerHello === null) settle({ error: why === 'timeout' ? 'timeout' : 'closed' });
      else if (awaitingProof)
        settle({ error: why === 'timeout' ? 'bad-proof' : 'closed', peerHello });
      else if (handlers) handlers.onClose(why);
      else closedWhy = why;
    };
    /** A refusal before the link is up: the caller learns why, then the socket goes. */
    const refuse = (
      result: { error: ConnectionError; peerHello?: HelloFrame },
      why: string,
      graceful: boolean,
    ): void => {
      clearTimeout(helloTimer);
      awaitingProof = false;
      settle(result);
      finish(why, graceful);
    };
    const goLive = (hello: HelloFrame): void => {
      clearTimeout(helloTimer);
      cancelTicker = every(() => {
        if (opts.now() - lastFrameAt >= downMs) finish('silence');
        else write({ t: 'ping' });
      }, pingMs);
      settle(connection(hello));
    };
    const write = (frame: LinkFrame): boolean => {
      if (closed) return false;
      const bytes = encodeFrame(frame);
      if (sock.writableLength + bytes.length > SEND_BUFFER_HARD_MAX) {
        // The frame is dropped, not queued: the peer has stopped reading, so the link is no use.
        finish('overflow');
        return false;
      }
      sock.write(bytes);
      return sock.writableLength <= SEND_BUFFER_MAX;
    };
    const helloTimer = setTimeout(() => finish('timeout'), opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    const connection = (hello: HelloFrame): LinkConnection => ({
      send: write,
      bufferedBytes: () => sock.writableLength,
      silentMs: () => opts.now() - lastFrameAt,
      close: (reason) => finish(reason, true),
      start: (h) => {
        if (handlers) return;
        handlers = h;
        for (const f of queued.splice(0)) h.onFrame(f);
        if (closedWhy !== null) h.onClose(closedWhy);
      },
      peerHello: hello,
    });

    const onHello = (frame: LinkFrame | null): void => {
      if (frame?.t !== 'hello') {
        refuse({ error: 'bad-hello' }, 'bad-hello', false);
        return;
      }
      if (frame.protocol.major !== opts.hello.protocol.major) {
        write({ t: 'bye', reason: 'incompatible' });
        refuse({ error: 'incompatible', peerHello: frame }, 'incompatible', true);
        return;
      }
      if (opts.proof === undefined) {
        peerHello = frame;
        goLive(frame);
        return;
      }
      // Below the proof minor the peer has no proof to send, so it is incompatible, not forged.
      if (frame.protocol.minor < HELLO_PROOF_MIN_MINOR) {
        write({ t: 'bye', reason: 'incompatible' });
        refuse({ error: 'incompatible', peerHello: frame }, 'incompatible', true);
        return;
      }
      if (frame.nonce === undefined) {
        refuse({ error: 'bad-proof', peerHello: frame }, 'bad-proof', true);
        return;
      }
      // Our proof goes out first, so the peer can check ours while we check its.
      peerHello = frame;
      awaitingProof = true;
      write({ t: 'hello.proof', sig: opts.proof.sign(frame.nonce, frame.machineId) });
    };

    const onProof = (frame: LinkFrame | null, hello: HelloFrame): void => {
      if (frame?.t !== 'hello.proof' || opts.proof === undefined) {
        // Anything before the proof is a protocol error: the peer has not shown it holds its key.
        refuse({ error: 'bad-proof', peerHello: hello }, 'bad-proof', true);
        return;
      }
      if (!opts.proof.verify(hello, frame.sig)) {
        opts.log.warn('link: ssh proof refused', { peer: hello.machineId });
        refuse({ error: 'bad-proof', peerHello: hello }, 'bad-proof', true);
        return;
      }
      awaitingProof = false;
      goLive(hello);
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
        if (awaitingProof) {
          onProof(frame, peerHello);
          continue;
        }
        if (frame?.t === 'hello.proof') {
          // Only an ssh handshake asks for a proof; a TLS peer that sends one is out of protocol.
          opts.log.warn('link: unexpected hello.proof', { peer: peerHello.machineId });
          finish('bad-proof');
          return;
        }
        if (frame === null) {
          // A frame this version doesn't know: a newer minor peer may send one; skipping keeps
          // the link up, and the features exchanged in hello stop it relying on the reply.
          opts.log.debug('link: unknown frame ignored', {});
          continue;
        }
        if (frame.t === 'ping') write({ t: 'pong' });
        else if (frame.t !== 'pong') deliver(frame);
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
