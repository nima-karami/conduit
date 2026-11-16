import { createConnection } from 'node:net';
import type { Duplex, Readable, Writable } from 'node:stream';
import {
  BRIDGE_EXIT_CODE,
  type BridgeFailureCode,
  type BridgePreamble,
} from '../../src/contracts/ssh-link';
import { encodeFrame } from '../../src/network/frame-codec';
import { readLinkEndpoint, readServerSecret } from '../../src/server-secret';

// `main.js --link-stdio`: sshd's stdio becomes one link to this server's link endpoint. Stdout
// carries link bytes only, so every diagnostic goes to stderr; the dialer reads that one line.
// The endpoint comes from the record the server wrote at its start, never from this process's
// environment: sshd's TMPDIR can differ from the app's. See the plan's decision 3 and Task 3.2.
// see docs/plans/2026-11-16-remote-ssh-stdio-link.plan.md decision 9

/** An endpoint that closes this soon after the preamble, with no byte back, refused the secret. */
const FIRST_BYTE_WINDOW_MS = 5_000;

export interface LinkStdioBridgeOptions {
  userData: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Test seam: the default connects to the link endpoint. */
  connect?: (endpoint: string) => Duplex;
}

export function runLinkStdioBridge(o: LinkStdioBridgeOptions): Promise<number> {
  const secret = readServerSecret(o.userData);
  if (secret === null) return failed(o, 'no_secret');

  const endpoint = readLinkEndpoint(o.userData);
  if (endpoint === null) return failed(o, 'no_server');
  const sock = (o.connect ?? createConnection)(endpoint);
  const preamble: BridgePreamble = { t: 'bridge', v: 1, secret };
  const startedAt = Date.now();
  let sawByte = false;
  let noServer = false;

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      o.stdin.unpipe(sock);
      // The link is over: the ssh child must exit now, not wait for sshd to close its stdin.
      o.stdin.destroy();
      sock.destroy();
      resolve(code);
    };

    // Written before connect: a net socket queues it, so the preamble is the first thing sent.
    sock.write(encodeFrame(preamble));
    o.stdin.pipe(sock);
    o.stdin.on('error', (error) => diag(o, `stdin: ${error.message}`));

    sock.on('data', (chunk: Buffer) => {
      sawByte = true;
      if (!o.stdout.write(chunk)) {
        sock.pause();
        o.stdout.once('drain', () => sock.resume());
      }
    });
    sock.on('error', (error: NodeJS.ErrnoException) => {
      if (!sawByte && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) {
        noServer = true;
      } else {
        diag(o, `link: ${error.message}`);
      }
    });

    // 'end' and 'close' both arrive for one socket; the first one decides.
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      if (noServer) {
        failed(o, 'no_server').then(finish);
      } else if (!sawByte && Date.now() - startedAt < FIRST_BYTE_WINDOW_MS) {
        failed(o, 'refused').then(finish);
      } else {
        finish(0);
      }
    };
    sock.once('end', onEnd);
    sock.once('close', onEnd);
  });
}

function failed(o: LinkStdioBridgeOptions, code: BridgeFailureCode): Promise<number> {
  return new Promise<number>((resolve) => {
    o.stderr.write(`conduit-bridge: ${code}\n`, () => resolve(BRIDGE_EXIT_CODE));
  });
}

function diag(o: LinkStdioBridgeOptions, message: string): void {
  o.stderr.write(`conduit-bridge: ${message}\n`);
}
