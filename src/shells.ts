import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_CLI_NAMES } from './launchers';
import type { HostPlatform } from './lsp-binary';
import type { AgentDefinition } from './types';

/** First path in `paths` that exists on disk, else undefined. */
function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** A relative entry resolves against Conduit's own cwd, so the repo it was started from could
 *  plant a `claude.cmd` there (review S1). */
function absolutePathDirs(pathVar: string | undefined): string[] {
  return (pathVar || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
}

/** First of `names` found on PATH, each directory in turn (Windows-aware: names include extension). */
function which(names: readonly string[]): string | undefined {
  const dirs = absolutePathDirs(process.env.PATH);
  return firstExisting(dirs.flatMap((d) => names.map((n) => path.join(d, n))));
}

const WIN_EXECUTABLE_EXT = ['.exe', '.cmd', '.bat'];

/** Absolute path → itself if it exists; bare name → PATH search trying (win32) '.exe', '.cmd',
 *  '.bat' in that order, (posix) the bare name. A relative path never resolves: its meaning would
 *  shift with the cwd Conduit happened to start in (review S2). undefined if not found.
 *  The walk probes the host file system, so it joins natively; `platform` picks the probe. */
export function resolveCommand(command: string, platform: HostPlatform): string | undefined {
  if ((platform === 'win32' ? /[\\/]/ : /\//).test(command)) {
    return path.isAbsolute(command) ? firstExisting([command]) : undefined;
  }
  if (platform !== 'win32') return which([command]);
  const lower = command.toLowerCase();
  if (WIN_EXECUTABLE_EXT.some((ext) => lower.endsWith(ext))) return which([command]);
  return which(WIN_EXECUTABLE_EXT.map((ext) => command + ext));
}

interface Candidate {
  id: string;
  label: string;
  exe: string;
  args?: string[];
  paths?: string[]; // explicit install locations checked before PATH
  pathsOnly?: boolean; // don't fall back to PATH (e.g. 'bash.exe' on PATH is WSL's, not Git Bash)
}

function terminalDef(id: string, label: string, command: string, args: string[]): AgentDefinition {
  return {
    id,
    label,
    command,
    args,
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  };
}

function toDef(c: Candidate): AgentDefinition | undefined {
  const command = firstExisting(c.paths ?? []) ?? (c.pathsOnly ? undefined : which([c.exe]));
  if (!command) return undefined;
  return terminalDef(c.id, c.label, command, c.args ?? []);
}

function winCandidates(): Candidate[] {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const sys32 = path.join(sysRoot, 'System32');
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    {
      id: 'shell:pwsh',
      label: 'PowerShell 7',
      exe: 'pwsh.exe',
      paths: [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        path.join(localAppData, 'Microsoft', 'PowerShell', '7', 'pwsh.exe'),
      ],
    },
    {
      id: 'shell:powershell',
      label: 'Windows PowerShell',
      exe: 'powershell.exe',
      paths: [path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
    },
    {
      id: 'shell:gitbash',
      label: 'Git Bash',
      exe: 'bash.exe',
      args: ['-i', '-l'],
      pathsOnly: true, // bash.exe on PATH is WSL's launcher, not Git Bash
      paths: [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
      ],
    },
    {
      id: 'shell:cmd',
      label: 'Command Prompt',
      exe: 'cmd.exe',
      paths: [path.join(sys32, 'cmd.exe')],
    },
    {
      id: 'shell:wsl',
      label: 'WSL',
      exe: 'wsl.exe',
      paths: [path.join(sys32, 'wsl.exe')],
    },
  ];
}

function unixCandidates(): Candidate[] {
  // -l (login) + -i (interactive) so the shell sources its profile files
  // (.zprofile/.profile/.bash_profile), matching how Terminal.app/iTerm launch.
  // sh is omitted: dash (a common /bin/sh) rejects -l, and sh has no profile of
  // its own to source — it's a last-resort fallback anyway.
  const login = () => ['-i', '-l'];
  return [
    {
      id: 'shell:zsh',
      label: 'zsh',
      exe: 'zsh',
      args: login(),
      paths: ['/bin/zsh', '/usr/bin/zsh'],
    },
    {
      id: 'shell:bash',
      label: 'bash',
      exe: 'bash',
      args: login(),
      paths: ['/bin/bash', '/usr/bin/bash'],
    },
    {
      id: 'shell:fish',
      label: 'fish',
      exe: 'fish',
      args: login(),
      paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'],
    },
    { id: 'shell:sh', label: 'sh', exe: 'sh', paths: ['/bin/sh'] },
  ];
}

/**
 * Detect the terminals/shells actually installed on this machine, as launchable
 * {@link AgentDefinition}s (PowerShell, Git Bash, cmd, WSL on Windows; zsh/bash/
 * fish/sh elsewhere). De-duped by resolved executable path.
 */
export function detectShells(): AgentDefinition[] {
  const candidates = process.platform === 'win32' ? winCandidates() : unixCandidates();
  const out: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const def = toDef(c);
    const key = def?.command.toLowerCase();
    if (def && key && !seen.has(key)) {
      seen.add(key);
      out.push(def);
    }
  }
  return out;
}

export interface CliScanEnv {
  platform: HostPlatform;
  pathDirs: readonly string[];
  homeDir: string;
  join: (...parts: string[]) => string;
  isFile: (p: string) => boolean;
  isExecutable: (p: string) => boolean;
}

/** Well-known user bin dirs a GUI-launched app's PATH often lacks (mf-new-session spec D4). */
const POSIX_EXTRA_DIRS = [
  '~/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.npm-global/bin',
  '~/.bun/bin',
];

/** win32 never probes `.ps1` (not CreateProcess-able) or extensionless (npm's sh shim). */
export function detectAgentClis(env: CliScanEnv): AgentDefinition[] {
  const isAbsolute = env.platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const pathDirs = env.pathDirs.filter((d) => isAbsolute(d));
  const posixDirs = () => {
    const extra = POSIX_EXTRA_DIRS.map((d) =>
      d.startsWith('~/') ? env.join(env.homeDir, d.slice(2)) : d,
    );
    return [...new Set([...pathDirs, ...extra])];
  };
  const find = (name: string): string | undefined => {
    if (env.platform === 'win32') {
      for (const dir of pathDirs) {
        for (const ext of WIN_EXECUTABLE_EXT) {
          const p = env.join(dir, name + ext);
          if (env.isFile(p)) return p;
        }
      }
      return undefined;
    }
    return posixDirs()
      .map((dir) => env.join(dir, name))
      .find((p) => env.isExecutable(p));
  };
  return AGENT_CLI_NAMES.flatMap((name) => {
    const command = find(name);
    return command ? [terminalDef(`cli:${name}`, name, command, [])] : [];
  });
}

export function hostCliScanEnv(): CliScanEnv {
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  return {
    platform:
      process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    pathDirs: absolutePathDirs(process.env.PATH),
    homeDir: os.homedir(),
    join: path.join,
    isFile,
    isExecutable: (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return isFile(p);
      } catch {
        return false;
      }
    },
  };
}
