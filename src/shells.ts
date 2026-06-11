import * as fs from 'node:fs';
import * as path from 'node:path';
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

/** Resolve an executable name against PATH (Windows-aware: name includes extension). */
function which(exe: string): string | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return firstExisting(dirs.map((d) => path.join(d, exe)));
}

interface Candidate {
  id: string;
  label: string;
  exe: string;
  args?: string[];
  paths?: string[]; // explicit install locations checked before PATH
  pathsOnly?: boolean; // don't fall back to PATH (e.g. 'bash.exe' on PATH is WSL's, not Git Bash)
}

function toDef(c: Candidate): AgentDefinition | undefined {
  const command = firstExisting(c.paths ?? []) ?? (c.pathsOnly ? undefined : which(c.exe));
  if (!command) return undefined;
  return {
    id: c.id,
    label: c.label,
    command,
    args: c.args ?? [],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  };
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
  return [
    { id: 'shell:zsh', label: 'zsh', exe: 'zsh', paths: ['/bin/zsh', '/usr/bin/zsh'] },
    { id: 'shell:bash', label: 'bash', exe: 'bash', paths: ['/bin/bash', '/usr/bin/bash'] },
    {
      id: 'shell:fish',
      label: 'fish',
      exe: 'fish',
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
