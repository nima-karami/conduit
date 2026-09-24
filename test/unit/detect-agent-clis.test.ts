import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CliScanEnv, detectAgentClis } from '../../src/shells';

const winEnv = (files: string[], pathDirs: string[]): CliScanEnv => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32',
    pathDirs,
    homeDir: 'C:\\Users\\u',
    join: path.win32.join,
    isFile: (p) => set.has(p.toLowerCase()),
    isExecutable: () => false,
  };
};

const posixEnv = (exes: string[], pathDirs: string[]): CliScanEnv => {
  const set = new Set(exes);
  return {
    platform: 'linux',
    pathDirs,
    homeDir: '/home/u',
    join: path.posix.join,
    isFile: (p) => set.has(p),
    isExecutable: (p) => set.has(p),
  };
};

const commands = (env: CliScanEnv) =>
  Object.fromEntries(detectAgentClis(env).map((d) => [d.id, d.command]));

describe('detectAgentClis', () => {
  it('win32 prefers .exe over .cmd in the same dir', () => {
    const env = winEnv(['C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe'], ['C:\\bin']);
    expect(commands(env)).toEqual({ 'cli:claude': 'C:\\bin\\claude.exe' });
  });

  it('win32 .cmd found when no .exe', () => {
    const env = winEnv(['C:\\npm\\codex.cmd'], ['C:\\npm']);
    expect(commands(env)).toEqual({ 'cli:codex': 'C:\\npm\\codex.cmd' });
  });

  it('win32 .bat found', () => {
    const env = winEnv(['C:\\b\\aider.bat'], ['C:\\b']);
    expect(commands(env)).toEqual({ 'cli:aider': 'C:\\b\\aider.bat' });
  });

  it('win32 claude.ps1 and extensionless claude are ignored', () => {
    const env = winEnv(['C:\\npm\\claude.ps1', 'C:\\npm\\claude'], ['C:\\npm']);
    expect(detectAgentClis(env)).toEqual([]);
  });

  it('win32 first PATH dir wins', () => {
    const env = winEnv(['C:\\b\\gemini.exe', 'C:\\a\\gemini.cmd'], ['C:\\a', 'C:\\b']);
    expect(commands(env)).toEqual({ 'cli:gemini': 'C:\\a\\gemini.cmd' });
  });

  it('posix bare name with X_OK', () => {
    const env = posixEnv(['/usr/bin/codex'], ['/usr/bin']);
    expect(commands(env)).toEqual({ 'cli:codex': '/usr/bin/codex' });
    const notExec: CliScanEnv = { ...env, isExecutable: () => false };
    expect(detectAgentClis(notExec)).toEqual([]);
  });

  it('posix ~/.local/bin probed even when not on PATH', () => {
    const env = posixEnv(['/home/u/.local/bin/claude', '/home/u/.bun/bin/opencode'], ['/usr/bin']);
    expect(commands(env)).toEqual({
      'cli:claude': '/home/u/.local/bin/claude',
      'cli:opencode': '/home/u/.bun/bin/opencode',
    });
  });

  it('ids cli:<name>, label name, args [], icon terminal, cwdStrategy workspaceFolder', () => {
    const env = winEnv(
      ['C:\\b\\claude.exe', 'C:\\b\\codex.exe', 'C:\\b\\cursor-agent.exe'],
      ['C:\\b'],
    );
    const defs = detectAgentClis(env);
    expect(defs.map((d) => d.id)).toEqual(['cli:claude', 'cli:codex', 'cli:cursor-agent']);
    expect(defs[2]).toEqual({
      id: 'cli:cursor-agent',
      label: 'cursor-agent',
      command: 'C:\\b\\cursor-agent.exe',
      args: [],
      icon: 'terminal',
      color: 'green',
      cwdStrategy: 'workspaceFolder',
    });
  });

  it('relative PATH entries are never probed (review S1)', () => {
    const win = winEnv(
      ['bin\\claude.exe', 'claude.cmd', 'C:\\b\\codex.exe'],
      ['bin', '.', 'C:\\b'],
    );
    expect(commands(win)).toEqual({ 'cli:codex': 'C:\\b\\codex.exe' });
    const posix = posixEnv(['node_modules/.bin/claude'], ['node_modules/.bin', '.']);
    expect(detectAgentClis(posix)).toEqual([]);
  });

  it('none found → []', () => {
    expect(detectAgentClis(winEnv([], ['C:\\a']))).toEqual([]);
    expect(detectAgentClis(posixEnv([], []))).toEqual([]);
  });
});
