import { describe, expect, it, vi } from 'vitest';
import { quitConfirmState } from '../../src/quit-guard';
import { trayHintFromHost } from '../../webview/bridge';

describe('tray host fact', () => {
  it.each([true, false, undefined])(
    'passes host availability %s into the quit dialog',
    (available) => {
      const host = available === undefined ? undefined : { trayAvailable: () => available };
      const state = quitConfirmState({
        reason: 'quit',
        running: 1,
        busy: 0,
        resolve: vi.fn(),
        trayHint: trayHintFromHost(host),
      });
      expect(state.message.includes('notification area')).toBe(available === true);
    },
  );
});
