import { describe, expect, it, vi } from 'vitest';
import {
  createDragOutHost,
  type DragOutHostDeps,
  type DragOutProbes,
} from '../../electron/drag-out-host';
import type { OsFileClipboard } from '../../electron/os-file-clipboard';
import { osFileClipboardSupported } from '../../src/drag-out-policy';
import { decodeClipboardStdin } from '../../src/os-clipboard-payload';
import type { OutgoingFolders, OutgoingVerdict } from '../../src/outgoing-paths';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

const FOLDERS: OutgoingFolders = { present: ['/w/home'], missing: [] };
const APP_CONTENTS = 7;
const APP_WINDOW = 1;

function setup(over: Partial<DragOutHostDeps> = {}) {
  const execute = vi.fn<OsFileClipboard['execute']>(async () => ({ ok: true }));
  const log = vi.fn();
  let probes: DragOutProbes | undefined;
  const installProbes = vi.fn((p: DragOutProbes) => {
    probes = p;
  });
  const deps: DragOutHostDeps = {
    platform: 'darwin',
    e2e: false,
    systemRoot: 'C:\\Windows',
    appWindowIdFor: (cid) => (cid === APP_CONTENTS ? APP_WINDOW : undefined),
    sessionFolders: (sid, wid) => (sid === 's1' && wid === APP_WINDOW ? FOLDERS : undefined),
    validate: (paths): OutgoingVerdict => ({ ok: true, paths: paths as string[] }),
    clipboard: { execute },
    installProbes,
    log,
    ...over,
  };
  const host = createDragOutHost(deps);
  const replies: HostToWebview[] = [];
  const ctx = (senderContentsId = APP_CONTENTS) => ({
    senderContentsId,
    reply: (m: HostToWebview) => replies.push(m),
  });
  return { host, replies, ctx, execute, log, installProbes, probes: () => probes };
}

const copyMsg = (
  paths: string[] = ['/w/home/a.txt'],
  over: Partial<Extract<WebviewToHost, { type: 'fs:copyToOsClipboard' }>> = {},
): Extract<WebviewToHost, { type: 'fs:copyToOsClipboard' }> => ({
  type: 'fs:copyToOsClipboard',
  requestId: 3,
  sessionId: 's1',
  paths,
  ...over,
});

describe('DragOutHost.copyToOsClipboard', () => {
  it('guest sender dropped', async () => {
    const t = setup();
    await t.host.copyToOsClipboard(copyMsg(), t.ctx(99));
    expect(t.replies).toEqual([]);
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith('warn', expect.any(String), expect.anything());
  });

  it('non-number requestId: logged, nothing replied', async () => {
    const t = setup();
    await t.host.copyToOsClipboard(
      copyMsg(undefined, { requestId: 'x' as unknown as number }),
      t.ctx(),
    );
    expect(t.replies).toEqual([]);
    expect(t.log).toHaveBeenCalledWith('warn', expect.any(String), expect.anything());
  });

  it('session of another window → unknown-session', async () => {
    const t = setup({ sessionFolders: () => undefined });
    await t.host.copyToOsClipboard(copyMsg(), t.ctx());
    expect(t.replies).toEqual([
      { type: 'fs:osClipboardResult', requestId: 3, ok: false, reason: 'unknown-session' },
    ]);
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('validates against the owned session folders', async () => {
    const validate = vi.fn((): OutgoingVerdict => ({ ok: true, paths: ['/w/home/a.txt'] }));
    const t = setup({ validate });
    await t.host.copyToOsClipboard(copyMsg(), t.ctx());
    expect(validate).toHaveBeenCalledWith(['/w/home/a.txt'], FOLDERS);
  });

  it('refusal carries reason+path', async () => {
    const t = setup({
      validate: () => ({ ok: false, reason: 'outside-folders', path: '/etc/passwd' }),
    });
    await t.host.copyToOsClipboard(copyMsg(['/etc/passwd']), t.ctx());
    expect(t.replies).toEqual([
      {
        type: 'fs:osClipboardResult',
        requestId: 3,
        ok: false,
        reason: 'outside-folders',
        path: '/etc/passwd',
      },
    ]);
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith('warn', 'os clipboard refused', {
      reason: 'outside-folders',
      path: '/etc/passwd',
    });
  });

  it('executes the validated paths, not the requested ones', async () => {
    const t = setup({ validate: () => ({ ok: true, paths: ['/w/home/d'] }) });
    await t.host.copyToOsClipboard(copyMsg(['/w/home/d', '/w/home/d/x']), t.ctx());
    expect(t.execute).toHaveBeenCalledTimes(1);
    const payload = t.execute.mock.calls[0][0];
    expect(payload.kind === 'plist' && payload.xml).toContain('<string>/w/home/d</string>');
    expect(payload.kind === 'plist' && payload.xml).not.toContain('/w/home/d/x');
    expect(t.replies).toEqual([{ type: 'fs:osClipboardResult', requestId: 3, ok: true }]);
  });

  it('e2e records the payload and never executes', async () => {
    const t = setup({ e2e: true, platform: 'darwin' });
    await t.host.copyToOsClipboard(copyMsg(['/w/home/ünï 日本.txt']), t.ctx());
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.probes()?.clipboard).toEqual([
      {
        payload: {
          kind: 'plist',
          format: 'NSFilenamesPboardType',
          xml: expect.stringContaining('<string>/w/home/ünï 日本.txt</string>'),
        },
      },
    ]);
    expect(t.replies).toEqual([{ type: 'fs:osClipboardResult', requestId: 3, ok: true }]);
  });

  it('e2e powershell entry carries the decoded stdin paths', async () => {
    const t = setup({ e2e: true, platform: 'win32' });
    await t.host.copyToOsClipboard(copyMsg(['C:\\w\\ünï 日本.txt']), t.ctx());
    expect(t.execute).not.toHaveBeenCalled();
    const entry = t.probes()?.clipboard[0];
    if (osFileClipboardSupported('win32')) {
      expect(entry?.payload.kind).toBe('powershell');
      expect(entry?.stdinPaths).toEqual(['C:\\w\\ünï 日本.txt']);
      if (entry?.payload.kind === 'powershell') {
        expect(decodeClipboardStdin(entry.payload.spawn.stdin)).toEqual(entry.stdinPaths);
      }
    } else {
      expect(entry).toBeUndefined();
      expect(t.replies).toEqual([
        { type: 'fs:osClipboardResult', requestId: 3, ok: false, reason: 'unsupported' },
      ]);
    }
  });

  it('installProbes only under e2e', () => {
    expect(setup({ e2e: false }).installProbes).not.toHaveBeenCalled();
    const t = setup({ e2e: true });
    expect(t.installProbes).toHaveBeenCalledTimes(1);
    expect(t.probes()).toEqual({ dragOut: [], clipboard: [] });
  });

  it('execute failure → failed with detail', async () => {
    const t = setup();
    t.execute.mockResolvedValueOnce({ ok: false, detail: 'timeout' });
    await t.host.copyToOsClipboard(copyMsg(), t.ctx());
    expect(t.replies).toEqual([
      {
        type: 'fs:osClipboardResult',
        requestId: 3,
        ok: false,
        reason: 'failed',
        detail: 'timeout',
      },
    ]);
    expect(t.log).toHaveBeenCalledWith('warn', expect.any(String), expect.anything());
  });

  it('linux → unsupported, no execute', async () => {
    const t = setup({ platform: 'linux' });
    await t.host.copyToOsClipboard(copyMsg(), t.ctx());
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.replies).toEqual([
      { type: 'fs:osClipboardResult', requestId: 3, ok: false, reason: 'unsupported' },
    ]);
  });
});
