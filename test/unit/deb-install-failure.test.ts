import { describe, expect, it } from 'vitest';
import { debInstallFailure, shellQuote } from '../../electron/deb-install-failure';

const PKEXEC_127 = new Error('Command pkexec exited with code 127');

describe('debInstallFailure', () => {
  it('explains a pkexec 127 .deb install and gives the sudo apt command with spaces quoted', () => {
    const result = debInstallFailure({
      platform: 'linux',
      downloadedFile: '/tmp/x y/conduit_1.2.3_amd64.deb',
      error: PKEXEC_127,
    });
    expect(result).not.toBeNull();
    expect(result?.command).toBe("sudo apt install '/tmp/x y/conduit_1.2.3_amd64.deb'");
    expect(result?.message).toMatch(/couldn't install/i);
    expect(result?.message).not.toMatch(/no password prompt|no polkit/i);
  });

  it('quotes a path containing a single quote safely', () => {
    const result = debInstallFailure({
      platform: 'linux',
      downloadedFile: "/home/ann/it's here/conduit_1.2.3_amd64.deb",
      error: PKEXEC_127,
    });
    expect(result?.command).toBe(
      "sudo apt install '/home/ann/it'\\''s here/conduit_1.2.3_amd64.deb'",
    );
  });

  it('is not this message for a non-deb package (AppImage)', () => {
    expect(
      debInstallFailure({
        platform: 'linux',
        downloadedFile: '/tmp/conduit-1.2.3.AppImage',
        error: PKEXEC_127,
      }),
    ).toBeNull();
  });

  it('is not this message on a non-linux platform', () => {
    expect(
      debInstallFailure({
        platform: 'win32',
        downloadedFile: 'C:\\tmp\\conduit_1.2.3_amd64.deb',
        error: PKEXEC_127,
      }),
    ).toBeNull();
  });

  it('is not this message for other failures or other exit codes', () => {
    const base = { platform: 'linux', downloadedFile: '/tmp/conduit_1.2.3_amd64.deb' };
    expect(
      debInstallFailure({ ...base, error: new Error('Command pkexec exited with code 126') }),
    ).toBeNull();
    expect(
      debInstallFailure({ ...base, error: new Error('Command sudo exited with code 127') }),
    ).toBeNull();
    expect(
      debInstallFailure({ ...base, error: new Error('net::ERR_CONNECTION_RESET') }),
    ).toBeNull();
    expect(debInstallFailure({ ...base, downloadedFile: null, error: PKEXEC_127 })).toBeNull();
  });
});

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shellQuote('/tmp/a b.deb')).toBe("'/tmp/a b.deb'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
