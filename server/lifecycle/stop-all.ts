import { createConnection, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import {
  SERVER_PROTOCOL_GENERATION,
  type ServerMethods,
  STOP_ALL_ANSWER_TIMEOUT_MS,
  STOP_ALL_CONNECT_TIMEOUT_MS,
} from '../../src/contracts/server-protocol';

export interface StopAllOptions {
  endpoint: string;
  version: string;
  auth?: ServerMethods['hello']['params']['auth'];
  directFallback(): Promise<number>;
  connect?: () => Socket;
}
export type StopAllResult =
  | { ok: true; killed: number; fallback: boolean }
  | { ok: false; reason: string };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function stopAll(options: StopAllOptions): Promise<StopAllResult> {
  return new Promise((resolve) => {
    let finished = false;
    let accepted = false;
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const teardown = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      return true;
    };
    const finish = (result: StopAllResult) => {
      if (teardown()) resolve(result);
    };
    const fallback = () => {
      if (!teardown()) return;
      void Promise.resolve()
        .then(options.directFallback)
        .then(
          (killed) => resolve({ ok: true, killed, fallback: true }),
          (error: unknown) => resolve({ ok: false, reason: String(error) }),
        );
    };
    timer = setTimeout(fallback, STOP_ALL_CONNECT_TIMEOUT_MS);
    try {
      socket = options.connect ? options.connect() : createConnection(options.endpoint);
    } catch {
      fallback();
      return;
    }
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    socket.on('connect', () => {
      if (!finished)
        socket?.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'hello',
            params: {
              appVersion: options.version,
              generation: SERVER_PROTOCOL_GENERATION,
              ...(options.auth !== undefined ? { auth: options.auth } : {}),
            },
          })}\n`,
        );
    });
    socket.on('data', (chunk: Buffer) => {
      if (finished) return;
      buffer += decoder.write(chunk);
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          if (accepted) finish({ ok: false, reason: 'Invalid stop reply' });
          else fallback();
          return;
        }
        if (!record(value) || value.jsonrpc !== '2.0') continue;
        if (
          !accepted &&
          value.id === 1 &&
          record(value.result) &&
          typeof value.result.serverVersion === 'string' &&
          typeof value.result.generation === 'number' &&
          typeof value.result.instance === 'string' &&
          typeof value.result.pid === 'number'
        ) {
          accepted = true;
          clearTimeout(timer);
          timer = setTimeout(
            () => finish({ ok: false, reason: 'server.stopAll answer timeout' }),
            STOP_ALL_ANSWER_TIMEOUT_MS,
          );
          socket?.write('{"jsonrpc":"2.0","id":2,"method":"server.stopAll","params":{}}\n');
        } else if (accepted && value.id === 2) {
          if (record(value.result) && typeof value.result.killed === 'number') {
            finish({ ok: true, killed: value.result.killed, fallback: false });
          } else {
            finish({
              ok: false,
              reason:
                record(value.error) && typeof value.error.message === 'string'
                  ? value.error.message
                  : 'Invalid stop reply',
            });
          }
        }
        if (finished) return;
      }
    });
    socket.on('error', () => {
      socket?.destroy();
    });
    socket.on('close', fallback);
  });
}
