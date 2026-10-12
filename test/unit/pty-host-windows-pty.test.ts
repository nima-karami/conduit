import { describe, expect, it, vi } from 'vitest';
import { windowsPtyInfo } from '../../src/pty-host';

vi.mock('@lydell/node-pty', () => ({ spawn: () => ({}) }));

describe('windowsPtyInfo', () => {
  it('reports ConPTY and the build number on Windows', () => {
    expect(windowsPtyInfo('win32', '10.0.22621')).toEqual({
      backend: 'conpty',
      buildNumber: 22621,
    });
    expect(windowsPtyInfo('win32', '10.0.19045')).toEqual({
      backend: 'conpty',
      buildNumber: 19045,
    });
  });

  it('is absent off Windows', () => {
    expect(windowsPtyInfo('linux', '6.8.0-1017-azure')).toBeUndefined();
    expect(windowsPtyInfo('darwin', '23.5.0')).toBeUndefined();
  });
});
