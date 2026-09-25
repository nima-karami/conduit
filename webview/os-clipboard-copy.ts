import { OS_CLIPBOARD_REPLY_TIMEOUT_MS } from '../src/drag-out-policy';
import { clipboardFailureMessage } from './drag-out-messages';
import { nameOf } from './file-tree';
import type { requestHost } from './host-request';

export interface OsClipboardCopierDeps {
  /** isHosted && osFileClipboardSupported(platform) */
  enabled: boolean;
  request: typeof requestHost;
  /** pushToast error + announce */
  report: (message: string) => void;
}

/** Last call wins: a result for a superseded call is ignored. No reply within
 *  OS_CLIPBOARD_REPLY_TIMEOUT_MS reads as 'failed'. */
export function createOsClipboardCopier(
  deps: OsClipboardCopierDeps,
): (sessionId: string, paths: string[]) => Promise<void> {
  let latest = 0;
  return async (sessionId, paths) => {
    if (!deps.enabled) return;
    const call = ++latest;
    const r = await deps.request(
      (requestId) => ({ type: 'fs:copyToOsClipboard', requestId, sessionId, paths }),
      ['fs:osClipboardResult'],
      OS_CLIPBOARD_REPLY_TIMEOUT_MS,
    );
    if (call !== latest || r?.ok || r?.reason === 'unsupported') return;
    const reason = r ? r.reason : 'failed';
    deps.report(clipboardFailureMessage(paths.length, reason, nameOf(r?.path ?? paths[0])));
  };
}
