import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { parse } from 'smol-toml';

export interface EndpointOptions {
  session?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
}

export function resolveHcEndpoint(options: EndpointOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const session = (options.session ?? env.HC_SESSION)?.trim() || 'default';
  const unsafe = [...session].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159) || '/\\:*?"<>|'.includes(char);
  });
  if (session === '.' || session === '..' || unsafe) {
    throw new Error(`Invalid HC_SESSION: ${JSON.stringify(session)}`);
  }
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const paths = platform === 'win32' ? win32 : posix;
  const home = env.HOME || homedir();
  const profile = env.USERPROFILE || 'C:\\';
  const configHome =
    env.XDG_CONFIG_HOME ||
    (platform === 'win32'
      ? env.APPDATA || win32.join(profile, 'AppData', 'Roaming')
      : posix.join(home, '.config'));
  const configPath = paths.join(configHome, 'herdr-core', 'config.toml');
  if (existsSync(configPath)) {
    const config = parse(readFileSync(configPath, 'utf8'));
    if (typeof config.socket === 'string') return config.socket;
  }
  if (platform === 'win32') {
    const user = (env.USERNAME || '').replace(/[^a-z0-9]/giu, '');
    return `\\\\.\\pipe\\herdr-core-${user}-${session}.sock`;
  }
  const uid = options.uid ?? process.getuid?.();
  const fallbackRuntime = uid === undefined ? undefined : `/run/user/${uid}`;
  const runtime =
    env.XDG_RUNTIME_DIR ||
    (fallbackRuntime && existsSync(fallbackRuntime) ? fallbackRuntime : undefined);
  const stateHome = env.XDG_STATE_HOME || posix.join(home, '.local', 'state');
  const directory = runtime
    ? posix.join(runtime, 'herdr-core')
    : posix.join(stateHome, 'herdr-core', session);
  return posix.join(directory, `${session}.sock`);
}
