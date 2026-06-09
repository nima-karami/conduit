import type { HostToWebview, WebviewToHost } from '../src/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

type Listener = (msg: HostToWebview) => void;

const listeners = new Set<Listener>();
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as HostToWebview;
  listeners.forEach((l) => l(msg));
});

const vscode: VsCodeApi | undefined = window.acquireVsCodeApi?.();

/** True inside VS Code (real PTY available); false in the browser preview. */
export const isHosted = !!vscode;

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function post(msg: WebviewToHost): void {
  if (vscode) {
    vscode.postMessage(msg);
  } else {
    mockHost(msg);
  }
}

// ----- Browser-preview fallback: a tiny fake shell so the terminal is visible
// in screenshots without a real extension host. Never runs inside VS Code.
function emit(msg: HostToWebview) {
  listeners.forEach((l) => l(msg));
}

const lineBuf = new Map<string, string>();

function mockHost(msg: WebviewToHost) {
  if (msg.type === 'term:start') {
    const id = msg.sessionId;
    lineBuf.set(id, '');
    setTimeout(() => {
      emit({
        type: 'term:data',
        sessionId: id,
        data:
          '\x1b[38;5;209m✷ Claude Code\x1b[0m \x1b[2m(preview — fake shell)\x1b[0m\r\n' +
          '\x1b[2mType something and press Enter. In VS Code this is a real PTY.\x1b[0m\r\n\r\n' +
          '\x1b[38;5;209m❯\x1b[0m ',
      });
    }, 60);
  } else if (msg.type === 'term:input') {
    const id = msg.sessionId;
    const ch = msg.data;
    if (ch === '\r') {
      const cmd = (lineBuf.get(id) ?? '').trim();
      lineBuf.set(id, '');
      const out = cmd ? `\r\n\x1b[2myou typed:\x1b[0m ${cmd}\r\n` : '\r\n';
      emit({ type: 'term:data', sessionId: id, data: `${out}\x1b[38;5;209m❯\x1b[0m ` });
    } else if (ch === '\x7f') {
      const cur = lineBuf.get(id) ?? '';
      lineBuf.set(id, cur.slice(0, -1));
      emit({ type: 'term:data', sessionId: id, data: '\b \b' });
    } else {
      lineBuf.set(id, (lineBuf.get(id) ?? '') + ch);
      emit({ type: 'term:data', sessionId: id, data: ch });
    }
  }
}
