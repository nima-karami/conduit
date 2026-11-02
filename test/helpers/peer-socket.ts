import type { Socket } from 'node:net';

const PEER_GONE = new Set(['ECONNRESET', 'EPIPE']);

/**
 * A test client of a server the test stops or restarts: on linux the server's close resets a peer
 * with unread bytes, and a socket with no 'error' listener turns that into an uncaught exception.
 * Any other error still surfaces as one.
 */
export function allowPeerReset<T extends Socket>(socket: T): T {
  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (!PEER_GONE.has(error.code ?? '')) throw error;
  });
  return socket;
}
