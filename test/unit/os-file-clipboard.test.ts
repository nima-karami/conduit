import { describe, expect, it, vi } from 'vitest';
import {
  createOsFileClipboard,
  type OsClipboardWriteResult,
} from '../../electron/os-file-clipboard';
import { OS_CLIPBOARD_REPLY_TIMEOUT_MS, OS_CLIPBOARD_TIMEOUT_MS } from '../../src/drag-out-policy';
import { buildPowerShellClipboardSpawn } from '../../src/os-clipboard-payload';

const ps = (p: string) =>
  ({ kind: 'powershell', spawn: buildPowerShellClipboardSpawn([p], 'C:\\Windows') }) as const;

function deferred() {
  let resolve: (r: OsClipboardWriteResult) => void = () => {};
  const promise = new Promise<OsClipboardWriteResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createOsFileClipboard', () => {
  it('only the newest pending write runs; a superseded one settles without spawning', async () => {
    const first = deferred();
    const runPowerShell = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true });
    const clip = createOsFileClipboard({ runPowerShell, writeBuffer: vi.fn() });
    const a = clip.execute(ps('C:\\a'));
    const b = clip.execute(ps('C:\\b'));
    const c = clip.execute(ps('C:\\c'));
    await expect(b).resolves.toEqual({ ok: false, detail: 'superseded' });
    first.resolve({ ok: true });
    await expect(a).resolves.toEqual({ ok: true });
    await expect(c).resolves.toEqual({ ok: true });
    expect(runPowerShell.mock.calls.map(([spec]) => spec)).toEqual([
      ps('C:\\a').spawn,
      ps('C:\\c').spawn,
    ]);
  });

  it('a burst queues at most one spawn behind the running one', async () => {
    const first = deferred();
    const runPowerShell = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ok: true });
    const clip = createOsFileClipboard({ runPowerShell, writeBuffer: vi.fn() });
    const all = Array.from({ length: 30 }, (_, i) => clip.execute(ps(`C:\\f${i}`)));
    first.resolve({ ok: true });
    await Promise.all(all);
    expect(runPowerShell).toHaveBeenCalledTimes(2);
  });

  it('the renderer waits for one write in flight plus one pending', () => {
    expect(OS_CLIPBOARD_REPLY_TIMEOUT_MS).toBeGreaterThan(2 * OS_CLIPBOARD_TIMEOUT_MS);
  });

  it('second execute waits for the first', async () => {
    const first = deferred();
    const second = deferred();
    const runPowerShell = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const clip = createOsFileClipboard({ runPowerShell, writeBuffer: vi.fn() });
    const a = clip.execute(ps('C:\\a'));
    const b = clip.execute(ps('C:\\b'));
    await flush();
    expect(runPowerShell).toHaveBeenCalledTimes(1);
    expect(runPowerShell).toHaveBeenCalledWith(ps('C:\\a').spawn, OS_CLIPBOARD_TIMEOUT_MS);
    first.resolve({ ok: true });
    await expect(a).resolves.toEqual({ ok: true });
    await flush();
    expect(runPowerShell).toHaveBeenCalledTimes(2);
    second.resolve({ ok: false, detail: 'boom' });
    await expect(b).resolves.toEqual({ ok: false, detail: 'boom' });
  });

  it('a rejected run settles as a failure and does not wedge the queue', async () => {
    const runPowerShell = vi
      .fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce({ ok: true });
    const clip = createOsFileClipboard({ runPowerShell, writeBuffer: vi.fn() });
    await expect(clip.execute(ps('C:\\a'))).resolves.toMatchObject({ ok: false });
    await expect(clip.execute(ps('C:\\b'))).resolves.toEqual({ ok: true });
  });

  it('plist → writeBuffer("NSFilenamesPboardType", Buffer of xml)', async () => {
    const writeBuffer = vi.fn();
    const clip = createOsFileClipboard({ runPowerShell: vi.fn(), writeBuffer });
    const xml = '<plist><array><string>/a</string></array></plist>';
    await expect(
      clip.execute({ kind: 'plist', format: 'NSFilenamesPboardType', xml }),
    ).resolves.toEqual({ ok: true });
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    const [format, data] = writeBuffer.mock.calls[0];
    expect(format).toBe('NSFilenamesPboardType');
    expect(Buffer.isBuffer(data) && data.toString('utf8')).toBe(xml);
  });

  it('a throwing writeBuffer is a failure with detail', async () => {
    const clip = createOsFileClipboard({
      runPowerShell: vi.fn(),
      writeBuffer: () => {
        throw new Error('pasteboard busy');
      },
    });
    await expect(
      clip.execute({ kind: 'plist', format: 'NSFilenamesPboardType', xml: '<x/>' }),
    ).resolves.toEqual({ ok: false, detail: 'pasteboard busy' });
  });
});
