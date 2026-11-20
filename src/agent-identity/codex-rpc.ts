export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export interface CodexPeer {
  request(method: string, params: JsonObject): Promise<JsonObject>;
  close(): void;
}

export interface CodexEvents {
  notify(method: string, params: JsonObject): void;
  disconnected(): void;
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: unknown,
    message: string,
  ) {
    super(message);
  }
}

interface Wire {
  send(line: string): void;
  close(): void;
}

const TIMEOUT_MS = 8_000;

export class CodexRpc implements CodexPeer {
  private nextId = 1;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (result: JsonObject) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly wire: Wire,
    private readonly events: CodexEvents,
  ) {}

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'conduit', version: '1' },
      capabilities: { experimentalApi: true },
    });
    this.wire.send(JSON.stringify({ method: 'initialized' }));
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closed) return Promise.reject(new Error('Codex App Server connection closed'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const fail = (error: Error) => {
        clearTimeout(this.pending.get(id)?.timer);
        this.pending.delete(id);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`Codex ${method} timed out`)), TIMEOUT_MS);
      this.pending.set(id, { resolve, reject: fail, timer });
      try {
        this.wire.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  receive(line: string) {
    let message: JsonObject;
    try {
      message = object(JSON.parse(line));
    } catch {
      this.close();
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id === undefined) this.events.notify(message.method, object(message.params));
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = object(message.error);
      pending.reject(new CodexRpcError(error.code, String(error.message)));
    } else {
      pending.resolve(object(message.result));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.wire.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex App Server connection closed'));
    }
    this.events.disconnected();
  }
}
