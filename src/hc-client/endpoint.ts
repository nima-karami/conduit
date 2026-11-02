import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { parse } from 'smol-toml';

export interface EndpointOptions {
  session?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
}

/**
 * herdr-core v0.1.16 docs/security.md "State and endpoints" (HC_SOCKET, config `socket`, the Unix
 * runtime/state fallbacks); the Windows pipe name is measured (`herdr-core-<account>-<session>.sock`,
 * the account stripped to alphanumerics: "Jo Sm.it-h" gives `JoSmith`).
 */
export function resolveHcEndpoint(options: EndpointOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const session = options.session ?? env.HC_SESSION ?? 'default';
  // The session names a path segment; refuse one that would leave its directory.
  if (!session || session === '.' || session === '..' || /[/\\\0]/u.test(session))
    throw new Error(`Invalid HC_SESSION: ${JSON.stringify(session)}`);
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const configHome =
    env.XDG_CONFIG_HOME ||
    (platform === 'win32'
      ? env.APPDATA || win32.join(homedir(), 'AppData', 'Roaming')
      : posix.join(env.HOME || homedir(), '.config'));
  const configPath = (platform === 'win32' ? win32 : posix).join(
    configHome,
    'herdr-core',
    'config.toml',
  );
  if (existsSync(configPath)) {
    const config = parse(readFileSync(configPath, 'utf8'));
    if (typeof config.socket === 'string') return config.socket;
  }
  if (platform === 'win32') {
    const account = (env.USERNAME || userInfo().username).replace(/[^\p{L}\p{N}]/gu, '');
    return `\\\\.\\pipe\\herdr-core-${account}-${session}.sock`;
  }
  const uid = options.uid ?? process.getuid?.();
  const userRuntime = uid === undefined ? undefined : `/run/user/${uid}`;
  const runtime =
    env.XDG_RUNTIME_DIR || (userRuntime && existsSync(userRuntime) ? userRuntime : undefined);
  const stateHome = env.XDG_STATE_HOME || posix.join(env.HOME || homedir(), '.local', 'state');
  const directory = runtime
    ? posix.join(runtime, 'herdr-core')
    : posix.join(stateHome, 'herdr-core', session);
  return posix.join(directory, `${session}.sock`);
}
