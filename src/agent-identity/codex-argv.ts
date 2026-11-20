const SERVER_CONFIG = new Map([
  ['--sandbox', 'sandbox_mode'],
  ['-s', 'sandbox_mode'],
  ['--ask-for-approval', 'approval_policy'],
  ['-a', 'approval_policy'],
  ['--model', 'model'],
  ['-m', 'model'],
]);

const CONFIG_FLAGS = new Set(['-c', '--config', '--enable', '--disable']);
const UNSUPPORTED = new Set([
  '--remote',
  '--remote-auth-token-env',
  '--profile',
  '-p',
  '--oss',
  '--local-provider',
  '--full-auto',
  '--yolo',
  '--dangerously-bypass-approvals-and-sandbox',
  '--approve-for-me',
  '--dangerously-bypass-hook-trust',
  '--cd',
  '-C',
  '--worktree',
  '--add-dir',
]);

function flagAt(arg: string): [string, string | undefined] {
  const equals = arg.indexOf('=');
  if (equals >= 0) return [arg.slice(0, equals), arg.slice(equals + 1)];
  const short = /^(-[sacmpC])(.+)$/.exec(arg);
  return short ? [short[1], short[2]] : [arg, undefined];
}

export function codexLaunchArgs(argv: readonly string[], exact: boolean) {
  const server: string[] = [];
  const tui: string[] = [];
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' || !arg.startsWith('-')) {
      tui.push(...argv.slice(i));
      if (arg === '--' && i === argv.length - 1) break;
      positional = true;
      break;
    }
    const first = i;
    const [flag, inline] = flagAt(arg);
    if (UNSUPPORTED.has(flag)) throw new Error(`Unsupported Codex identity launch flag ${flag}`);
    const key = SERVER_CONFIG.get(flag);
    if (key || CONFIG_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (!value || (inline === undefined && value.startsWith('-'))) {
        throw new Error(`Missing Codex launch value for ${flag}`);
      }
      if (key) server.push('-c', `${key}=${JSON.stringify(value)}`);
      else server.push(flag, value);
      const serverPermission =
        key === 'sandbox_mode' ||
        key === 'approval_policy' ||
        ((flag === '-c' || flag === '--config') &&
          /^(sandbox_mode|approval_policy|approvals_reviewer|default_permissions|permissions|sandbox_workspace_write)(?:[.\s=]|$)/.test(
            value,
          ));
      // Codex refuses remote resume when the TUI receives explicit permission flags.
      if (!exact || !serverPermission) tui.push(...argv.slice(first, i + 1));
    } else if (flag !== '--no-daemon' && flag !== '--no-alt-screen' && flag !== '--strict-config') {
      throw new Error(`Unsupported Codex identity launch flag ${flag}`);
    } else {
      if (flag === '--strict-config') server.push(flag);
      tui.push(arg);
    }
  }
  if (positional && exact) throw new Error('Codex exact resume conflicts with an existing prompt');
  if (positional && !argv.includes('--')) {
    throw new Error('Codex identity launch requires -- before a prompt');
  }
  return { server, tui };
}
