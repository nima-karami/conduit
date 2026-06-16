import { describe, expect, it } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

describe('update protocol types', () => {
  it('updateStatus message is assignable to HostToWebview', () => {
    const msgs: HostToWebview[] = [
      { type: 'updateStatus', status: 'checking' },
      { type: 'updateStatus', status: 'available', version: '0.2.0' },
      { type: 'updateStatus', status: 'available', version: '0.2.0', releaseNotes: 'Bug fixes' },
      { type: 'updateStatus', status: 'downloading', percent: 42 },
      { type: 'updateStatus', status: 'ready', version: '0.2.0' },
      { type: 'updateStatus', status: 'up-to-date' },
      { type: 'updateStatus', status: 'error', message: 'Network error' },
    ];
    expect(msgs).toHaveLength(7);
  });

  it('updateCheck and updateRelaunch are assignable to WebviewToHost', () => {
    const msgs: WebviewToHost[] = [{ type: 'updateCheck' }, { type: 'updateRelaunch' }];
    expect(msgs).toHaveLength(2);
  });
});
