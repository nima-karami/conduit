import type { SshFailure, SshNeedsPersonReason } from '../contracts/ssh-link';
import type { RemoteCommand } from './remote-scripts';

// The remote command is one ssh argument that the remote shell re-parses, so an arg with a line
// break would split it, and a NUL cannot cross an exec boundary at all. See plan decision 7.
const UNQUOTABLE = /[\0\n\r]/;

/** POSIX-quotes each arg for the remote shell; null when an arg cannot cross the boundary. */
export function posixQuote(args: readonly string[]): string | null {
  if (args.some((arg) => UNQUOTABLE.test(arg))) return null;
  return args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

// Only a NUL cannot cross the exec boundary; line breaks are the script's own and pass through.
function rawOf(text: string): string | null {
  return text.includes('\0') ? null : text;
}

// ssh expands %h and %r into a user's ProxyCommand and Match exec lines, so a target with shell
// metacharacters reaches a local shell (CVE-2023-51385). Only host-name characters are allowed.
const TARGET_ALLOWED = /^[A-Za-z0-9._@:%+[\]-]+$/;

/** The one target rule: C2 checks it before a call reaches ssh, and sshArgv checks it again. */
export function isSshTarget(target: string): boolean {
  return TARGET_ALLOWED.test(target) && !target.startsWith('-');
}

/**
 * `rawRemote` is for remote-scripts.ts strings only. Its scripts are multi-line sh text the remote
 * shell must parse as written, and posixQuote would refuse their newlines and re-quote them into one
 * word. Nothing else may be fed here: an argv is always quoted through `remote`.
 */
export type SshArgvInput = { target: string; controlPath: string } & (
  | { remote: readonly string[] }
  | { rawRemote: RemoteCommand }
);

export function sshArgv(o: SshArgvInput): string[] | { error: 'bad_target' | 'bad_arg' } {
  // A leading '-' would be read as an option even after `--` is refused here, not trusted to ssh.
  if (!isSshTarget(o.target)) {
    return { error: 'bad_target' };
  }
  const remote = 'rawRemote' in o ? rawOf(o.rawRemote.command) : posixQuote(o.remote);
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

/**
 * The argv of the needs-person pane (a visible terminal the owner answers). It shares the dialer's
 * ControlPath so the master it opens is the one the batch dial reuses, and it keeps prompts: no
 * BatchMode and no -T. The forwarding options stay off, as on every Conduit ssh.
 */
export function personSshArgv(o: {
  target: string;
  controlPath: string;
}): string[] | { error: 'bad_target' } {
  if (!isSshTarget(o.target)) return { error: 'bad_target' };
  return [...personOptions(o.controlPath), '--', o.target];
}

function personOptions(controlPath: string): string[] {
  return [
    '-o',
    'ControlMaster=yes',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlPersist=8h',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
  ];
}

/**
 * The argv of an agent-setup pane: the needs-person options with a forced tty (-t) for the one
 * fixed remote command, which comes after the target. The command is a setup-table string, never
 * user text (agent-setup-commands.ts).
 */
export function setupSshArgv(o: {
  target: string;
  controlPath: string;
  command: string;
}): string[] | { error: 'bad_target' } {
  if (!isSshTarget(o.target)) return { error: 'bad_target' };
  return [...personOptions(o.controlPath), '-t', '--', o.target, o.command];
}

// OpenSSH's mux listener binds `<ControlPath>.<16 random chars>` and renames it into place, so the
// bound path is 17 bytes longer than the expanded ControlPath. Measured on the Linux VM: a 49-byte
// dir binds, a 50-byte one fails with "unix_listener: path … too long" (plan decision 8).
const SOCKET_PATH_MAX_BYTES = 107;
const MUX_BIND_SUFFIX_BYTES = 17;
const EXPANDED_CONTROL_PATH_MAX_BYTES = SOCKET_PATH_MAX_BYTES - MUX_BIND_SUFFIX_BYTES;
// '/' plus the 40-hex hash that %C expands to.
const CONTROL_HASH_SUFFIX_BYTES = 41;

function fitsControlPath(dir: string): boolean {
  // Bytes, not characters: the kernel measures a socket path in bytes.
  return (
    new TextEncoder().encode(dir).length + CONTROL_HASH_SUFFIX_BYTES <=
    EXPANDED_CONTROL_PATH_MAX_BYTES
  );
}

/**
 * The first candidate directory whose ControlPath fits, or null. Candidates are ordered so the
 * per-user location wins: userData, then XDG_RUNTIME_DIR (per-user and 0700), then tmpdir, where
 * the uid keeps another local user from pre-creating our name.
 */
export function controlDir(o: {
  userData: string;
  tmpdir: string;
  xdgRuntimeDir: string | undefined;
  uid: number;
  instance: string;
  join: (...p: string[]) => string;
}): string | null {
  const candidates: (string | null)[] = [
    o.join(o.userData, 'ssh'),
    o.xdgRuntimeDir?.startsWith('/') ? o.join(o.xdgRuntimeDir, `conduit-ssh-${o.instance}`) : null,
    o.join(o.tmpdir, `conduit-ssh-${o.uid}-${o.instance}`),
  ];
  return candidates.find((dir): dir is string => dir !== null && fitsControlPath(dir)) ?? null;
}

export type E2eSshArgsPrefix =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'prefix'; argv: string[] };

/**
 * The leading argv the e2e stand-in runs under, so `node fake-ssh.cjs` replaces a real ssh where a
 * .cjs cannot be exec-ed. Read only in e2e mode: production's ssh argv is fixed (plan 4.2.1), and
 * an environment-chosen prefix would let the environment pick what runs before the ssh arguments.
 */
export function readE2eSshArgsPrefix(raw: string | undefined, e2e: boolean): E2eSshArgsPrefix {
  if (!e2e || raw === undefined) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string')) {
    return { kind: 'prefix', argv: parsed };
  }
  return { kind: 'invalid' };
}

const STDERR_DETAIL_MAX = 200;

const BRIDGE_RULES: [RegExp, SshFailure][] = [
  [/conduit-bridge:\s*no_server/i, { code: 'bridge_no_server' }],
  [/conduit-bridge:\s*no_secret/i, { code: 'bridge_no_secret' }],
  [/conduit-bridge:\s*refused/i, { code: 'bridge_refused' }],
  [/conduit-bridge:\s*untrusted_endpoint/i, { code: 'bridge_untrusted_endpoint' }],
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
  // Anchored to ssh's own "(method,method)" list: a remote "EACCES: permission denied" line is not
  // an auth failure, and it must not become the non-retryable one.
  if (/Permission denied \([a-z,-]+\)/i.test(stderr)) return { code: 'ssh_auth_failed' };
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
