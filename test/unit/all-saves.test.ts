import { beforeEach, describe, expect, it, vi } from 'vitest';

// The close and quit dialogs save through one probe; each key must reach the store that owns it.
const m = vi.hoisted(() => {
  const store = (owned: string) => ({
    getStatus: vi.fn((key: string) =>
      key === owned ? { phase: 'dirty', edited: true, conflict: null, error: null } : undefined,
    ),
    isPartial: vi.fn(() => false),
    save: vi.fn(async () => true),
    subscribe: vi.fn(() => () => {}),
  });
  return { local: store('/w/a.txt'), remote: store('remote-file@M1:/w/a.txt') };
});
vi.mock('../../webview/file-saves', () => ({ fileSaves: m.local }));
vi.mock('../../webview/remote-file-saves', () => ({ remoteFileSaves: m.remote }));

import { allSaves } from '../../webview/all-saves';

beforeEach(() => {
  for (const s of [m.local, m.remote]) s.save.mockClear();
});

describe('allSaves', () => {
  it('saves a remote tab through the remote store and a local file through the local one', async () => {
    await allSaves.save('remote-file@M1:/w/a.txt', 'manual');
    expect(m.remote.save).toHaveBeenCalledWith('remote-file@M1:/w/a.txt', 'manual');
    expect(m.local.save).not.toHaveBeenCalled();

    await allSaves.save('/w/a.txt', 'manual');
    expect(m.local.save).toHaveBeenCalledWith('/w/a.txt', 'manual');
    expect(m.remote.save).toHaveBeenCalledTimes(1);
  });

  it('reports a remote tab as having an entry, so the dialog offers to save it', () => {
    expect(allSaves.getStatus('remote-file@M1:/w/a.txt')?.phase).toBe('dirty');
    expect(allSaves.getStatus('/w/a.txt')?.phase).toBe('dirty');
  });
});
