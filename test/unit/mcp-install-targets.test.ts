import { describe, expect, it } from 'vitest';
import {
  claudeLocalTarget,
  foundMarkers,
  installableInProject,
  openCodeJsoncPath,
  projectTarget,
  type TargetEnv,
  userTarget,
} from '../../electron/mcp-install-targets';

const base: TargetEnv = { homeDir: '/h', env: {}, userDataDir: '/u', platform: 'linux' };
const withEnv = (env: Record<string, string>): TargetEnv => ({ ...base, env });

describe('userTarget', () => {
  it('claude user file honours CLAUDE_CONFIG_DIR; empty string is unset', () => {
    expect(userTarget('claude', withEnv({ CLAUDE_CONFIG_DIR: '/c' })).path).toBe('/c/.claude.json');
    expect(userTarget('claude', withEnv({ CLAUDE_CONFIG_DIR: '' }))).toMatchObject({
      path: '/h/.claude.json',
      format: 'json',
      keys: ['mcpServers', 'conduit'],
      scope: 'user',
      backupPath: '/h/.claude.json.conduit-backup',
    });
  });

  it('codex honours CODEX_HOME; opencode honours XDG_CONFIG_HOME; cursor ignores env', () => {
    expect(userTarget('codex', base)).toMatchObject({
      path: '/h/.codex/config.toml',
      format: 'toml',
    });
    expect(userTarget('codex', withEnv({ CODEX_HOME: '/x' })).path).toBe('/x/config.toml');
    expect(userTarget('codex', withEnv({ CODEX_HOME: '' })).path).toBe('/h/.codex/config.toml');
    expect(userTarget('opencode', base)).toMatchObject({
      path: '/h/.config/opencode/opencode.json',
      keys: ['mcp', 'conduit'],
    });
    expect(userTarget('opencode', withEnv({ XDG_CONFIG_HOME: '/xdg' })).path).toBe(
      '/xdg/opencode/opencode.json',
    );
    expect(userTarget('opencode', withEnv({ XDG_CONFIG_HOME: '' })).path).toBe(
      '/h/.config/opencode/opencode.json',
    );
    const cursorEnv = withEnv({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', XDG_CONFIG_HOME: '/y' });
    expect(userTarget('cursor', cursorEnv)).toMatchObject({
      path: '/h/.cursor/mcp.json',
      keys: ['mcpServers', 'conduit'],
    });
  });

  it('mtimeGuard only for claude user', () => {
    expect(userTarget('claude', base).mtimeGuard).toBe(true);
    for (const cli of ['codex', 'cursor', 'opencode'] as const) {
      expect(userTarget(cli, base).mtimeGuard).toBe(false);
      expect(projectTarget(cli, '/r', base).mtimeGuard).toBe(false);
    }
    expect(projectTarget('claude', '/r', base).mtimeGuard).toBe(false);
  });

  it('win32 joins with backslashes', () => {
    const win: TargetEnv = { ...base, homeDir: 'C:\\Users\\me', platform: 'win32' };
    expect(userTarget('claude', win).path).toBe('C:\\Users\\me\\.claude.json');
  });
});

describe('projectTarget', () => {
  it('per-CLI project files and key paths', () => {
    expect(projectTarget('claude', '/r', base)).toMatchObject({
      path: '/r/.mcp.json',
      keys: ['mcpServers', 'conduit'],
      scope: 'project',
      format: 'json',
    });
    expect(projectTarget('codex', '/r', base)).toMatchObject({
      path: '/r/.codex/config.toml',
      format: 'toml',
    });
    expect(projectTarget('cursor', '/r', base).path).toBe('/r/.cursor/mcp.json');
    expect(projectTarget('opencode', '/r', base)).toMatchObject({
      path: '/r/opencode.json',
      keys: ['mcp', 'conduit'],
    });
  });

  it('project backups live under userData, never the root', () => {
    const claude = projectTarget('claude', '/r', base).backupPath;
    const codex = projectTarget('codex', '/r', base).backupPath;
    expect(claude.startsWith('/u/mcp-install-backups/')).toBe(true);
    expect(codex.startsWith('/u/mcp-install-backups/')).toBe(true);
    expect(claude).not.toBe(codex);
    expect(claude.endsWith('/.mcp.json.conduit-backup')).toBe(true);
    expect(codex.endsWith('/.codex__config.toml.conduit-backup')).toBe(true);
    expect(projectTarget('claude', '/other', base).backupPath).not.toBe(claude);
    expect(projectTarget('claude', '/r/', base).backupPath).toBe(claude);
  });
});

describe('claudeLocalTarget', () => {
  it('claudeLocalTarget matches trailing slash; case-insensitive only on win32', () => {
    const json = { projects: { '/R/Proj/': { mcpServers: {} } } };
    expect(claudeLocalTarget('/r/proj', json, base)).toBeNull();
    const win = claudeLocalTarget('/r/proj', json, { ...base, platform: 'win32' });
    expect(win?.keys).toEqual(['projects', '/R/Proj/', 'mcpServers', 'conduit']);
    expect(win?.keys[1]).toBe('/R/Proj/');
    expect(win).toMatchObject({ scope: 'local', mtimeGuard: true, format: 'json' });
    expect(claudeLocalTarget('/R/Proj', json, base)?.keys[1]).toBe('/R/Proj/');
  });

  it('matches backslash keys and lives in the user file', () => {
    const json = { projects: { 'C:\\Work\\App': {} } };
    const win: TargetEnv = { ...base, platform: 'win32' };
    const t = claudeLocalTarget('c:/work/app/', json, win);
    expect(t?.keys[1]).toBe('C:\\Work\\App');
    expect(t?.path).toBe(userTarget('claude', win).path);
    expect(t?.backupPath).toBe(userTarget('claude', win).backupPath);
  });

  it('no projects map → null', () => {
    expect(claudeLocalTarget('/r', {}, base)).toBeNull();
    expect(claudeLocalTarget('/r', { projects: [] }, base)).toBeNull();
  });
});

describe('markers and capabilities', () => {
  it('foundMarkers per CLI', () => {
    expect(foundMarkers('claude', base)).toEqual(['/h/.claude.json', '/h/.claude']);
    expect(foundMarkers('claude', withEnv({ CLAUDE_CONFIG_DIR: '/c' }))).toEqual([
      '/c/.claude.json',
      '/c',
    ]);
    expect(foundMarkers('codex', base)).toEqual(['/h/.codex']);
    expect(foundMarkers('cursor', base)).toEqual(['/h/.cursor']);
    expect(foundMarkers('opencode', withEnv({ XDG_CONFIG_HOME: '/y' }))).toEqual(['/y/opencode']);
  });

  it('openCodeJsoncPath is the sibling of the user file', () => {
    expect(openCodeJsoncPath(base)).toBe('/h/.config/opencode/opencode.jsonc');
  });

  it('installableInProject false only for cursor', () => {
    expect(installableInProject('cursor')).toBe(false);
    for (const cli of ['claude', 'codex', 'opencode'] as const) {
      expect(installableInProject(cli)).toBe(true);
    }
  });
});
