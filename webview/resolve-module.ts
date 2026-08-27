/**
 * Ask the host to resolve a module specifier a navigation missed on, and push what it finds
 * to the language worker so the navigation can be retried.
 *
 * The round trip is modelled on `md:image`'s: a monotonic `requestId`, one `subscribe` torn
 * down in a `finally`, and a timeout so a host that never answers cannot wedge the navigation
 * inside `ts-nav`'s own deadline.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md §1-2.
 */

import { withTimeout } from '../src/with-timeout';
import { post, subscribe } from './bridge';
import { addIndexedFiles } from './ts-project';

/** Comfortably inside `ts-nav`'s 6 s navigation deadline, and long enough for a cold walk of
 *  a large package on a loaded machine. */
const RESOLVE_TIMEOUT_MS = 4000;

let requestSeq = 0;

/** In-flight requests, so a hop chain or a double-click can't fan out duplicate host work. */
const inflight = new Map<string, Promise<string | null>>();

function request(sessionId: string, fromFile: string, specifier: string): Promise<string | null> {
  const requestId = ++requestSeq;
  let unsub = () => {};
  const answered = new Promise<string | null>((resolve) => {
    unsub = subscribe((msg) => {
      if (msg.type !== 'resolveModuleResult' || msg.requestId !== requestId) return;
      if (!msg.ok || !msg.files?.length || !msg.entry) {
        resolve(null);
        return;
      }
      addIndexedFiles(msg.files);
      resolve(msg.entry);
    });
    post({ type: 'resolveModule', requestId, sessionId, fromFile, specifier });
  });
  // The subscription is torn down on the TIMEOUT path too — a host that never answers would
  // otherwise leave one listener per missed navigation alive for the window's lifetime.
  return withTimeout<string | null>(answered, RESOLVE_TIMEOUT_MS, null).finally(() => unsub());
}

/**
 * Resolve `specifier` from `fromFile` through the host and index what it finds.
 * Resolves to the entry file the host landed on, or null when nothing resolved.
 */
export function resolveModuleOnDemand(
  sessionId: string | null,
  fromFile: string,
  specifier: string,
): Promise<string | null> {
  if (!sessionId) return Promise.resolve(null);
  const key = `${fromFile}\0${specifier}`;
  const running = inflight.get(key);
  if (running) return running;
  const pending = request(sessionId, fromFile, specifier)
    .catch(() => null)
    // Cleared on settle rather than cached: a second attempt after an `npm install` must reach
    // the host again, and the host's own cache is what keeps the repeat cheap.
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}
