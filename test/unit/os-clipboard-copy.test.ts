import { describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import {
  createOsClipboardCopier,
  type OsClipboardCopierDeps,
} from '../../webview/os-clipboard-copy';

type Result = Extract<HostToWebview, { type: 'fs:osClipboardResult' }> | null;

function fakeRequest() {
  const sent: WebviewToHost[] = [];
  const pending: ((r: Result) => void)[] = [];
  let id = 0;
  const request = ((send: (requestId: number) => WebviewToHost) => {
    sent.push(send(++id));
    return new Promise<Result>((resolve) => pending.push(resolve));
  }) as unknown as OsClipboardCopierDeps['request'];
  return { request, sent, pending };
}

const ok = (requestId: number): Result => ({ type: 'fs:osClipboardResult', requestId, ok: true });

describe('createOsClipboardCopier', () => {
  it('posts the session and paths', async () => {
    const f = fakeRequest();
    const copy = createOsClipboardCopier({ enabled: true, request: f.request, report: vi.fn() });
    const done = copy('s1', ['/w/a']);
    expect(f.sent).toEqual([
      { type: 'fs:copyToOsClipboard', requestId: 1, sessionId: 's1', paths: ['/w/a'] },
    ]);
    f.pending[0](ok(1));
    await done;
  });

  it('superseded result ignored', async () => {
    const f = fakeRequest();
    const report = vi.fn();
    const copy = createOsClipboardCopier({ enabled: true, request: f.request, report });
    const first = copy('s1', ['/w/a']);
    const second = copy('s1', ['/w/b']);
    f.pending[1](ok(2));
    await second;
    f.pending[0]({
      type: 'fs:osClipboardResult',
      requestId: 1,
      ok: false,
      reason: 'failed',
      detail: 'x',
    });
    await first;
    expect(report).not.toHaveBeenCalled();
  });

  it('the latest failure is reported, naming the refused item', async () => {
    const f = fakeRequest();
    const report = vi.fn();
    const copy = createOsClipboardCopier({ enabled: true, request: f.request, report });
    const done = copy('s1', ['/w/a.txt', '/w/b.txt']);
    f.pending[0]({
      type: 'fs:osClipboardResult',
      requestId: 1,
      ok: false,
      reason: 'missing',
      path: '/w/b.txt',
    });
    await done;
    expect(report).toHaveBeenCalledWith(
      "Couldn't put 2 items on the system clipboard. Can't drag b.txt: it no longer exists.",
    );
  });

  it('null reply → failed', async () => {
    const f = fakeRequest();
    const report = vi.fn();
    const copy = createOsClipboardCopier({ enabled: true, request: f.request, report });
    const done = copy('s1', ['/w/a']);
    f.pending[0](null);
    await done;
    expect(report).toHaveBeenCalledWith(
      "Couldn't put 1 item on the system clipboard. PowerShell didn't respond.",
    );
  });

  it('unsupported → silent', async () => {
    const f = fakeRequest();
    const report = vi.fn();
    const copy = createOsClipboardCopier({ enabled: true, request: f.request, report });
    const done = copy('s1', ['/w/a']);
    f.pending[0]({ type: 'fs:osClipboardResult', requestId: 1, ok: false, reason: 'unsupported' });
    await done;
    expect(report).not.toHaveBeenCalled();
  });

  it('disabled → no request', async () => {
    const f = fakeRequest();
    const copy = createOsClipboardCopier({ enabled: false, request: f.request, report: vi.fn() });
    await copy('s1', ['/w/a']);
    expect(f.sent).toEqual([]);
  });
});
