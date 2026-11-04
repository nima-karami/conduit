import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));

import { UPDATES_UNAVAILABLE_MSG, updatesSupported } from '../../electron/updater';

describe('updatesSupported', () => {
  it('is true only when the build ships app-update.yml', () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p.replaceAll('\\', '/'));
      return p.endsWith('app-update.yml');
    };
    expect(updatesSupported('/opt/conduit/resources', exists)).toBe(true);
    expect(seen).toEqual(['/opt/conduit/resources/app-update.yml']);
    expect(updatesSupported('/opt/conduit/resources', () => false)).toBe(false);
  });

  it('tells the user plainly instead of surfacing ENOENT', () => {
    expect(UPDATES_UNAVAILABLE_MSG).toBe("Updates aren't available in this build.");
  });
});
