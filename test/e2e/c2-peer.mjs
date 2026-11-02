import { connect } from 'node:net';

/** One C2 connection: newline-delimited JSON-RPC, with every `event` notification kept in order. */
export class C2 {
  static open(endpoint) {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      socket.once('connect', () => resolve(new C2(socket)));
      socket.once('error', reject);
    });
  }
  constructor(socket) {
    this.socket = socket;
    this.events = [];
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.method === 'event') this.events.push(message.params);
        const waiter = this.pending.get(message.id);
        if (waiter && message.method === undefined) {
          this.pending.delete(message.id);
          if (message.error)
            waiter.reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
          else waiter.resolve(message.result);
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error('C2 closed'));
      this.pending.clear();
    });
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params) {
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  close() {
    this.socket.destroy();
  }
}
