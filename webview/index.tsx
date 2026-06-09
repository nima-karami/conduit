import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import type { HostToWebview, WebviewToHost } from '../src/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const vscode: VsCodeApi = window.acquireVsCodeApi?.() ?? { postMessage: () => {} };
export const post = (m: WebviewToHost) => vscode.postMessage(m);

type StateMsg = Extract<HostToWebview, { type: 'state' }>;

const root = createRoot(document.getElementById('root')!);

function render(state: StateMsg | null, error?: string) {
  root.render(<App state={state} error={error} post={post} />);
}

render(null);

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as HostToWebview;
  if (msg.type === 'state') render(msg);
  else if (msg.type === 'error') render(null, msg.message);
});

post({ type: 'ready' });
