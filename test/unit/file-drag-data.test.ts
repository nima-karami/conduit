import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../src/protocol';
import { stampFileDrag } from '../../webview/file-drag-data';

const bridge = vi.hoisted(() => ({ hosted: true, posted: [] as WebviewToHost[] }));
vi.mock('../../webview/bridge', () => ({
  get isHosted() {
    return bridge.hosted;
  },
  post: (m: WebviewToHost) => bridge.posted.push(m),
}));

function fakeDt() {
  const data = new Map<string, string>();
  const dt: Pick<DataTransfer, 'setData'> = {
    setData(t, v) {
      data.set(t, v);
    },
  };
  return { data, dt: dt as DataTransfer };
}

afterEach(() => {
  bridge.hosted = true;
  bridge.posted.length = 0;
});

describe('stampFileDrag', () => {
  it('download: DownloadURL plus the host arm, nothing for the terminal', () => {
    const { data, dt } = fakeDt();
    stampFileDrag(dt, '/w/a b.txt', { download: true, terminal: false });
    expect([...data]).toEqual([
      ['DownloadURL', 'application/octet-stream:a b.txt:file:///w/a%20b.txt'],
    ]);
    expect(bridge.posted).toEqual([{ type: 'fs:armDragDownload', path: '/w/a b.txt' }]);
  });

  it('terminal: the x-conduit-path reference', () => {
    const { data, dt } = fakeDt();
    stampFileDrag(dt, '/w/a.txt', { download: false, terminal: true });
    expect([...data]).toEqual([['application/x-conduit-path', '/w/a.txt']]);
    expect(bridge.posted).toEqual([]);
  });

  it('browser preview (no host to gate it): no DownloadURL', () => {
    bridge.hosted = false;
    const { data, dt } = fakeDt();
    stampFileDrag(dt, '/w/a.txt', { download: true, terminal: true });
    expect([...data.keys()]).toEqual(['application/x-conduit-path']);
    expect(bridge.posted).toEqual([]);
  });

  it('a name DownloadURL cannot express arms nothing', () => {
    const { data, dt } = fakeDt();
    stampFileDrag(dt, '/w/a:b.txt', { download: true, terminal: false });
    expect(data.size).toBe(0);
    expect(bridge.posted).toEqual([]);
  });
});
