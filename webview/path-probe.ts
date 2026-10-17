// Host `pathExists` round-trip for navigation history's reopen-on-Back (spec
// docs/specs/archive/2026-09-22-editor-nav-history.md §2.4). The reply carries no request id, so it is
// correlated by the path the host echoes back verbatim.

import { canonicalPath } from '../src/canonical-path';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { post, subscribe } from './bridge';

export const PROBE_TIMEOUT_MS = 2000;

export interface ProbeTransport {
  post(msg: WebviewToHost): void;
  subscribe(cb: (msg: HostToWebview) => void): () => void;
}

/** 'file' | 'dir' on an existing path; null on a miss or no reply by `timeoutMs`. The terminal
 *  link click re-checks with this before opening (spec 2026-10-16-terminal-path-links row 55). */
export function probePathKind(
  path: string,
  transport: ProbeTransport = { post, subscribe },
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<'file' | 'dir' | null> {
  const want = canonicalPath(path);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: 'file' | 'dir' | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = transport.subscribe((msg) => {
      if (msg.type === 'pathExistsResult' && msg.path === want)
        settle(msg.exists ? (msg.isDir ? 'dir' : 'file') : null);
    });
    timer = setTimeout(() => settle(null), timeoutMs);
    transport.post({ type: 'pathExists', path: want });
  });
}

/** True only for an existing non-directory; false on a directory, a miss, or no reply by `timeoutMs`. */
export async function probePathExists(
  path: string,
  transport: ProbeTransport = { post, subscribe },
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return (await probePathKind(path, transport, timeoutMs)) === 'file';
}
