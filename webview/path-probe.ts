// Host `pathExists` round-trip for navigation history's reopen-on-Back (spec
// docs/specs/2026-09-22-editor-nav-history.md §2.4). The reply carries no request id, so it is
// correlated by the path the host echoes back verbatim.

import { canonicalPath } from '../src/canonical-path';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { post, subscribe } from './bridge';

export const PROBE_TIMEOUT_MS = 2000;

export interface ProbeTransport {
  post(msg: WebviewToHost): void;
  subscribe(cb: (msg: HostToWebview) => void): () => void;
}

/** True only for an existing non-directory; false on a directory, a miss, or no reply by `timeoutMs`. */
export function probePathExists(
  path: string,
  transport: ProbeTransport = { post, subscribe },
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const want = canonicalPath(path);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = transport.subscribe((msg) => {
      if (msg.type === 'pathExistsResult' && msg.path === want) settle(msg.exists && !msg.isDir);
    });
    timer = setTimeout(() => settle(false), timeoutMs);
    transport.post({ type: 'pathExists', path: want });
  });
}
