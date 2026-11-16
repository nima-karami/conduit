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

  it('refuses shell metacharacters and option-like text in a target', () => {
    for (const target of [';id', 'a`id`', '$(x)', 'host=x', 'h|x', "it's"]) {
      expect(sshArgv({ target, controlPath: '/d/%C', remote: ['node'] })).toEqual({
        error: 'bad_target',
      });
    }
  });

  it('accepts user@host, IPv6 literals, dotted names and zone ids', () => {
    for (const target of ['user@host', '[::1]', 'host.local', 'fe80::1%eth0']) {
      expect(sshArgv({ target, controlPath: '/d/%C', remote: ['node'] })).toBeInstanceOf(Array);
    }
  });

  it('refuses a remote argument that cannot be quoted', () => {
    expect(sshArgv({ target: 'vm', controlPath: '/d/%C', remote: ['node', 'a\nb'] })).toEqual({
      error: 'bad_arg',
    });
  });
});

describe('controlDir', () => {
  // The expanded ControlPath (dir + '/' + 40-hex hash) must be at most 90 bytes, so the dir at most
  // 49. Measured on the Linux VM: 49 binds, 50 fails with "unix_listener: path … too long".
  const base = { tmpdir: '/tmp', xdgRuntimeDir: undefined, uid: 1000, instance: 'abc' };
  const at = (length: number) => 'u'.repeat(length - '/ssh'.length);

  it('uses <userData>/ssh at exactly 49 bytes', () => {
    const userData = at(49);
    expect(controlDir({ ...base, userData, join })).toBe(`${userData}/ssh`);
  });

  it('moves on at 50 bytes, the first length that fails to bind', () => {
    const userData = at(50);
    expect(controlDir({ ...base, userData, join })).toBe('/tmp/conduit-ssh-1000-abc');
  });

  it('prefers XDG_RUNTIME_DIR over tmpdir when userData is too long', () => {
    expect(controlDir({ ...base, userData: at(60), xdgRuntimeDir: '/run/user/1000', join })).toBe(
      '/run/user/1000/conduit-ssh-abc',
    );
  });

  it('ignores a relative XDG_RUNTIME_DIR', () => {
    expect(controlDir({ ...base, userData: at(60), xdgRuntimeDir: 'run/user', join })).toBe(
      '/tmp/conduit-ssh-1000-abc',
    );
  });

  it('names the tmpdir fallback with the uid, so another user cannot pre-create it', () => {
    expect(controlDir({ ...base, uid: 4242, userData: at(60), join })).toBe(
      '/tmp/conduit-ssh-4242-abc',
    );
  });

  it('returns null when no candidate fits', () => {
    expect(controlDir({ ...base, tmpdir: 'T'.repeat(30), userData: at(60), join })).toBeNull();
  });

  it('counts bytes, not characters', () => {
    // 23 characters but 46 bytes: the dir is 50 bytes once '/ssh' is added, one past the limit.
    const userData = 'é'.repeat(23);
    expect(userData.length + '/ssh'.length).toBeLessThanOrEqual(49);
    expect(new TextEncoder().encode(userData).length + '/ssh'.length).toBeGreaterThan(49);
    expect(controlDir({ ...base, userData, join })).toBe('/tmp/conduit-ssh-1000-abc');
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
      'permission denied, password method',
      255,
      'user@vm: Permission denied (publickey,password).',
      { code: 'ssh_auth_failed' },
    ],
    [
      'permission denied, keyboard-interactive method',
      255,
      'Permission denied (publickey,keyboard-interactive).',
      { code: 'ssh_auth_failed' },
    ],
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

  it('does not read a remote EACCES line as an auth failure', () => {
    expect(classifySshFailure(2, 'EACCES: permission denied, open /x/y')).toEqual({
      code: 'ssh_failed',
      detail: 'EACCES: permission denied, open /x/y',
    });
    expect(classifySshFailure(127, 'bash: /x/node: Permission denied')).toEqual({
      code: 'ssh_failed',
      detail: 'bash: /x/node: Permission denied',
    });
  });

  it('returns null for exit 0 with empty stderr', () => {
    expect(classifySshFailure(0, '')).toBeNull();
  });
});
