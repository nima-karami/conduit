import type { Socket } from 'node:net';

/**
 * A raw peer's newline-delimited lines, split on the bytes the socket delivers. Deliberately not
 * the product's framing, so a defect there still fails the tests that use this.
 */
export function onLines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      onLine(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
}

export function writeJsonLine(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}
