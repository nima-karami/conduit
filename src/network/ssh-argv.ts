import type { SshFailure, SshNeedsPersonReason } from '../contracts/ssh-link';

// The remote command is one ssh argument that the remote shell re-parses, so an arg with a line
// break would split it, and a NUL cannot cross an exec boundary at all. See plan decision 7.
const UNQUOTABLE = /[\0\n\r]/;

/** POSIX-quotes each arg for the remote shell; null when an arg cannot cross the boundary. */
export function posixQuote(args: readonly string[]): string | null {
  if (args.some((arg) => UNQUOTABLE.test(arg))) return null;
  return args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

// A target that begins with '-' would be read by ssh as an option, so it is refused here rather
// than trusted to the `--` terminator alone. Whitespace and NUL never belong in a host name.
const TARGET_UNSAFE = /\s|\0/;

export function sshArgv(o: {
  target: string;
  controlPath: string;
  remote: readonly string[];
}): string[] | { error: 'bad_target' | 'bad_arg' } {
  if (o.target === '' || o.target.startsWith('-') || TARGET_UNSAFE.test(o.target)) {
    return { error: 'bad_target' };
  }
  const remote = posixQuote(o.remote);
  if (remote === null) return { error: 'bad_arg' };
  // Keepalives bound how long a dead link takes to show (docs/runs/2026-11-16-CON-35/gates.md).
  // BatchMode keeps every prompt from blocking: a prompt becomes a typed failure instead.
  return [
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
    `ControlPath=${o.controlPath}`,
    '-o',
    'ControlPersist=60',
    '--',
    o.target,
    remote,
  ];
}

// OpenSSH expands %C to a 40-hex hash; with the joining '/' that is 41 bytes on top of the dir.
const CONTROL_SUFFIX_BYTES = 41;
const SOCKET_PATH_MAX_BYTES = 100;

/** Where ControlPath sockets live: under userData when short enough, else in tmpdir. */
export function controlDir(o: {
  userData: string;
  tmpdir: string;
  instance: string;
  join: (...p: string[]) => string;
}): string {
  const dir = o.join(o.userData, 'ssh');
  // Bytes, not characters: a socket path is measured by the kernel in bytes.
  if (new TextEncoder().encode(dir).length + CONTROL_SUFFIX_BYTES <= SOCKET_PATH_MAX_BYTES) {
    return dir;
  }
  return o.join(o.tmpdir, `conduit-ssh-${o.instance}`);
}

const STDERR_DETAIL_MAX = 200;

const BRIDGE_RULES: [RegExp, SshFailure][] = [
  [/conduit-bridge:\s*no_server/i, { code: 'bridge_no_server' }],
  [/conduit-bridge:\s*no_secret/i, { code: 'bridge_no_secret' }],
  [/conduit-bridge:\s*refused/i, { code: 'bridge_refused' }],
];

const UNREACHABLE =
  /Could not resolve hostname|Connection timed out|Connection refused|No route to host|Network is unreachable|Timeout, server .* not responding/i;

const needsPerson = (reason: SshNeedsPersonReason): SshFailure => ({
  code: 'ssh_needs_person',
  reason,
});

/**
 * Maps one ssh child's exit to a typed failure, or null for a clean exit. Order matters: the
 * "Permission denied (publickey,password)" line of an auth failure also contains "password", and
 * with BatchMode no password prompt can appear, so that line is an auth failure, not a prompt.
 */
export function classifySshFailure(exitCode: number | null, stderr: string): SshFailure | null {
  // ssh's own warnings on a clean exit are not failures, so an exit of 0 is always null.
  if (exitCode === 0) return null;
  for (const [pattern, failure] of BRIDGE_RULES) {
    if (pattern.test(stderr)) return failure;
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return needsPerson('host_key_changed');
  }
  if (/Host key verification failed|No .* host key is known/i.test(stderr)) {
    return needsPerson('host_key_unknown');
  }
  if (/Permission denied/i.test(stderr)) return { code: 'ssh_auth_failed' };
  if (/passphrase/i.test(stderr)) return needsPerson('passphrase');
  if (/password/i.test(stderr)) return needsPerson('password');
  if (/verification code|one-time|keyboard-interactive/i.test(stderr)) {
    return needsPerson('mfa');
  }
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const unreachable = lines.find((line) => UNREACHABLE.test(line));
  if (unreachable !== undefined) return { code: 'ssh_unreachable', detail: unreachable };
  const last = lines[lines.length - 1] ?? '';
  return { code: 'ssh_failed', detail: last.slice(0, STDERR_DETAIL_MAX) };
}
