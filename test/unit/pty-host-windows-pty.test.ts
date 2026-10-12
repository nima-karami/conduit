import { describe, expect, it, vi } from 'vitest';
import { windowsPtyInfo } from '../../src/pty-host';

vi.mock('@lydell/node-pty', () => ({ spawn: () => ({}) }));

describe('windowsPtyInfo', () => {
  it('reports ConPTY and the build number on Windows', () => {
    expect(windowsPtyInfo('win32', '10.0.22621', false)).toEqual({
      backend: 'conpty',
      buildNumber: 22621,
    });
  });

  it('reports winpty under a debugger, the backend the host then spawns on', () => {
    expect(windowsPtyInfo('win32', '10.0.19045', true)).toEqual({
      backend: 'winpty',
      buildNumber: 19045,
    });
  });

  it('is absent off Windows', () => {
    expect(windowsPtyInfo('linux', '6.8.0-1017-azure', false)).toBeUndefined();
    expect(windowsPtyInfo('darwin', '23.5.0', true)).toBeUndefined();
  });
});
