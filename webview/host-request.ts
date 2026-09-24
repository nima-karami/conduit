import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { post, subscribe } from './bridge';

let seq = 0;

/** Posts send(id) with a fresh id and resolves the first reply of one of `types` carrying that
 *  requestId, or null after timeoutMs. Unsubscribes either way. */
export function requestHost<T extends HostToWebview['type']>(
  send: (requestId: number) => WebviewToHost,
  types: readonly T[],
  timeoutMs: number,
): Promise<Extract<HostToWebview, { type: T }> | null> {
  const requestId = ++seq;
  return new Promise((resolve) => {
    const settle = (v: Extract<HostToWebview, { type: T }> | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(v);
    };
    const unsubscribe = subscribe((m) => {
      if (
        (types as readonly string[]).includes(m.type) &&
        'requestId' in m &&
        m.requestId === requestId
      ) {
        settle(m as Extract<HostToWebview, { type: T }>);
      }
    });
    const timer = setTimeout(() => settle(null), timeoutMs);
    post(send(requestId));
  });
}
