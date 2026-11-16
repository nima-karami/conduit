import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifySshFailure, controlDir, posixQuote, sshArgv } from '../../src/network/ssh-argv';

const join = (...p: string[]) => p.join('/');

describe('posixQuote', () => {
  it('wraps each argument in single quotes and joins them with spaces', () => {
    expect(posixQuote(['node', 'main.js', '--user-data', '/home/u/x y'])).toBe(
      "'node' 'main.js' '--user-data' '/home/u/x y'",
    );
  });

  it("escapes a single quote as '\\''", () => {
    expect(posixQuote(["it's"])).toBe(`'it'\\''s'`);
  });

  it('refuses an argument containing NUL, LF or CR', () => {
    expect(posixQuote(['a\0b'])).toBeNull();
    expect(posixQuote(['a\nb'])).toBeNull();
    expect(posixQuote(['a\rb'])).toBeNull();
  });
});

describe('sshArgv', () => {
  it('returns the fixed argv with the target after --', () => {
    expect(sshArgv({ target: 'vm', controlPath: '/d/%C', remote: ['node', 'main.js'] })).toEqual([
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPath=/d/%C',
      '-o',
      'ControlPersist=60',
      '--',
      'vm',
      "'node' 'main.js'",
    ]);
  });

  it('never carries StrictHostKeyChecking', () => {
    const argv = sshArgv({ target: 'vm', controlPath: '/d/%C', remote: ['node'] });
    expect(argv).toBeInstanceOf(Array);
    expect((argv as string[]).join(' ')).not.toMatch(/StrictHostKeyChecking|accept-new/);
  });

  it('refuses a target that starts with -', () => {
    expect(sshArgv({ target: '-oProxyCommand=x', controlPath: '/d/%C', remote: ['node'] })).toEqual(
      {
        error: 'bad_target',
      },
    );
  });

  it('refuses an empty target, or one with whitespace or NUL', () => {
    for (const target of ['', 'a b', 'a\tb', 'a\nb', 'a\0b']) {
      expect(sshArgv({ target, controlPath: '/d/%C', remote: ['node'] })).toEqual({
        error: 'bad_target',
      });
    }
  });

  it('refuses a remote argument that cannot be quoted', () => {
    expect(sshArgv({ target: 'vm', controlPath: '/d/%C', remote: ['node', 'a\nb'] })).toEqual({
      error: 'bad_arg',
    });
  });
});

describe('controlDir', () => {
  // The ControlPath is `<dir>/%C` and OpenSSH's %C hash is 40 hex characters, so 41 bytes more.
  const LIMIT = 100 - 41;

  it('uses <userData>/ssh when the ControlPath fits in 100 bytes', () => {
    const userData = 'u'.repeat(LIMIT - '/ssh'.length);
    const dir = controlDir({ userData, tmpdir: '/tmp', instance: 'abc', join });
    expect(dir).toBe(`${userData}/ssh`);
    expect(Buffer.byteLength(dir) + 41).toBe(100);
  });

  it('falls back to tmpdir one byte past the limit', () => {
    const userData = 'u'.repeat(LIMIT - '/ssh'.length + 1);
    expect(controlDir({ userData, tmpdir: '/tmp', instance: 'abc', join })).toBe(
      '/tmp/conduit-ssh-abc',
    );
  });

  it('counts bytes, not characters', () => {
    const userData = 'é'.repeat(30);
    expect(userData.length + 4 <= LIMIT).toBe(true);
    expect(Buffer.byteLength(userData) + 4 > LIMIT).toBe(true);
    expect(controlDir({ userData, tmpdir: '/tmp', instance: 'abc', join })).toBe(
      '/tmp/conduit-ssh-abc',
    );
  });

  it('joins with the injected join, not a platform separator', () => {
    const calls: string[][] = [];
    controlDir({
      userData: '/short',
      tmpdir: '/tmp',
      instance: 'abc',
      join: (...p) => {
        calls.push(p);
        return p.join('|');
      },
    });
    expect(calls).toEqual([['/short', 'ssh']]);
    expect(path.isAbsolute('/short')).toBe(true);
  });
});

describe('classifySshFailure', () => {
  const cases: [string, number | null, string, unknown][] = [
    ['bridge no_server', 3, 'conduit-bridge: no_server', { code: 'bridge_no_server' }],
    ['bridge no_secret', 3, 'conduit-bridge: no_secret', { code: 'bridge_no_secret' }],
    ['bridge refused', 3, 'conduit-bridge: refused', { code: 'bridge_refused' }],
    [
      'host key changed',
      255,
      'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!',
      { code: 'ssh_needs_person', reason: 'host_key_changed' },
    ],
    [
      'host key verification failed',
      255,
      'Host key verification failed.',
      { code: 'ssh_needs_person', reason: 'host_key_unknown' },
    ],
    [
      'no host key known',
      255,
      'No ECDSA host key is known for vm and you have requested strict checking.',
      { code: 'ssh_needs_person', reason: 'host_key_unknown' },
    ],
    [
      'passphrase',
      255,
      'Enter passphrase for key /home/u/.ssh/id_ed25519:',
      { code: 'ssh_needs_person', reason: 'passphrase' },
    ],
    ['password', 255, 'vm@10.0.0.2 password:', { code: 'ssh_needs_person', reason: 'password' }],
    ['verification code', 255, 'Verification code:', { code: 'ssh_needs_person', reason: 'mfa' }],
    ['one-time password', 255, 'Enter one-time code:', { code: 'ssh_needs_person', reason: 'mfa' }],
    [
      'keyboard-interactive',
      255,
      'keyboard-interactive auth failed',
      { code: 'ssh_needs_person', reason: 'mfa' },
    ],
    ['permission denied', 255, 'vm: Permission denied (publickey).', { code: 'ssh_auth_failed' }],
    [
      'could not resolve',
      255,
      'ssh: Could not resolve hostname nope: Name or service not known',
      {
        code: 'ssh_unreachable',
        detail: 'ssh: Could not resolve hostname nope: Name or service not known',
      },
    ],
    [
      'connection timed out',
      255,
      'ssh: connect to host 10.0.0.9 port 22: Connection timed out',
      {
        code: 'ssh_unreachable',
        detail: 'ssh: connect to host 10.0.0.9 port 22: Connection timed out',
      },
    ],
    [
      'connection refused',
      255,
      'ssh: connect to host vm port 22: Connection refused',
      {
        code: 'ssh_unreachable',
        detail: 'ssh: connect to host vm port 22: Connection refused',
      },
    ],
    [
      'no route to host',
      255,
      'ssh: connect to host 10.0.0.9 port 22: No route to host',
      {
        code: 'ssh_unreachable',
        detail: 'ssh: connect to host 10.0.0.9 port 22: No route to host',
      },
    ],
    [
      'network unreachable',
      255,
      'ssh: connect to host 10.0.0.9 port 22: Network is unreachable',
      {
        code: 'ssh_unreachable',
        detail: 'ssh: connect to host 10.0.0.9 port 22: Network is unreachable',
      },
    ],
    [
      'server not responding',
      255,
      'ssh: Timeout, server 10.0.0.9 not responding.',
      { code: 'ssh_unreachable', detail: 'ssh: Timeout, server 10.0.0.9 not responding.' },
    ],
  ];

  it.each(cases)('maps %s', (_name, code, stderr, expected) => {
    expect(classifySshFailure(code, stderr)).toEqual(expected);
  });

  it('matches case-insensitively', () => {
    expect(classifySshFailure(255, 'host key VERIFICATION FAILED.')).toEqual({
      code: 'ssh_needs_person',
      reason: 'host_key_unknown',
    });
  });

  it('maps an unrecognised non-zero exit to ssh_failed with the last stderr line', () => {
    expect(classifySshFailure(2, 'first line\nsecond line\n')).toEqual({
      code: 'ssh_failed',
      detail: 'second line',
    });
  });

  it('caps the ssh_failed detail at 200 characters', () => {
    const failure = classifySshFailure(2, 'x'.repeat(500));
    expect(failure).toEqual({ code: 'ssh_failed', detail: 'x'.repeat(200) });
  });

  it('returns null for exit 0 with empty stderr', () => {
    expect(classifySshFailure(0, '')).toBeNull();
  });
});
