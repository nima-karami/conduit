import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { AgentCli, ProjectScope } from '../src/conduit-mcp/install-types';
import type { JsonObject } from '../src/conduit-mcp/json-config';
import { folderKey } from '../src/folder-key';
import type { HostPlatform } from '../src/lsp-binary';

export interface TargetEnv {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  userDataDir: string;
  platform: HostPlatform;
}

export interface ConfigTarget {
  cli: AgentCli;
  scope: 'user' | ProjectScope;
  /** The file shown in the row and edited. */
  path: string;
  format: 'json' | 'toml';
  /** JSON key path to the conduit entry; TOML is always mcp_servers.conduit. */
  keys: readonly string[];
  backupPath: string;
  /** True only for Claude's user file: a running Claude rewrites it (spec §3.5, D1). */
  mtimeGuard: boolean;
}

const SERVERS = ['mcpServers', 'conduit'] as const;
const OPENCODE = ['mcp', 'conduit'] as const;

// The platform is a parameter, not process.platform, so ubuntu CI exercises the win32 rules.
const pathsFor = (t: TargetEnv) => (t.platform === 'win32' ? path.win32 : path.posix);

/** Scenarios can't unset a runner variable, only blank it (plan "Spec staleness"). */
function envDir(t: TargetEnv, name: string): string | undefined {
  const v = t.env[name];
  return v === undefined || v === '' ? undefined : v;
}

const claudeDir = (t: TargetEnv) => envDir(t, 'CLAUDE_CONFIG_DIR');
const codexDir = (t: TargetEnv) => envDir(t, 'CODEX_HOME') ?? pathsFor(t).join(t.homeDir, '.codex');
const cursorDir = (t: TargetEnv) => pathsFor(t).join(t.homeDir, '.cursor');
// see docs/runs/2026-10-27-mcp-install/s0.md (OpenCode config dir)
const openCodeDir = (t: TargetEnv) =>
  pathsFor(t).join(
    envDir(t, 'XDG_CONFIG_HOME') ?? pathsFor(t).join(t.homeDir, '.config'),
    'opencode',
  );
const claudeUserFile = (t: TargetEnv) =>
  pathsFor(t).join(claudeDir(t) ?? t.homeDir, '.claude.json');

export function userTarget(cli: AgentCli, t: TargetEnv): ConfigTarget {
  const p = pathsFor(t);
  const make = (file: string, format: 'json' | 'toml', keys: readonly string[]): ConfigTarget => ({
    cli,
    scope: 'user',
    path: file,
    format,
    keys,
    backupPath: `${file}.conduit-backup`,
    mtimeGuard: cli === 'claude',
  });
  switch (cli) {
    case 'claude':
      return make(claudeUserFile(t), 'json', SERVERS);
    case 'codex':
      return make(p.join(codexDir(t), 'config.toml'), 'toml', ['mcp_servers', 'conduit']);
    case 'cursor':
      return make(p.join(cursorDir(t), 'mcp.json'), 'json', SERVERS);
    case 'opencode':
      return make(p.join(openCodeDir(t), 'opencode.json'), 'json', OPENCODE);
  }
}

const PROJECT_FILES: Readonly<
  Record<AgentCli, { rel: readonly string[]; format: 'json' | 'toml'; keys: readonly string[] }>
> = {
  claude: { rel: ['.mcp.json'], format: 'json', keys: SERVERS },
  codex: { rel: ['.codex', 'config.toml'], format: 'toml', keys: ['mcp_servers', 'conduit'] },
  cursor: { rel: ['.cursor', 'mcp.json'], format: 'json', keys: SERVERS },
  opencode: { rel: ['opencode.json'], format: 'json', keys: OPENCODE },
};

// Backups never go into the repo: a stray *.conduit-backup there would be committed (spec §3.5).
export function projectTarget(cli: AgentCli, root: string, t: TargetEnv): ConfigTarget {
  const p = pathsFor(t);
  const { rel, format, keys } = PROJECT_FILES[cli];
  const bucket = createHash('sha256').update(folderKey(root)).digest('hex').slice(0, 16);
  return {
    cli,
    scope: 'project',
    path: p.join(root, ...rel),
    format,
    keys,
    backupPath: p.join(
      t.userDataDir,
      'mcp-install-backups',
      bucket,
      `${rel.join('__')}.conduit-backup`,
    ),
    mtimeGuard: false,
  };
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function projectKeyOf(p: string, platform: HostPlatform): string {
  const k = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? k.toLowerCase() : k;
}

export function claudeLocalTarget(
  root: string,
  userJson: JsonObject,
  t: TargetEnv,
): ConfigTarget | null {
  const projects = userJson.projects;
  if (!isObject(projects)) return null;
  const want = projectKeyOf(root, t.platform);
  const key = Object.keys(projects).find((k) => projectKeyOf(k, t.platform) === want);
  if (key === undefined) return null;
  const user = userTarget('claude', t);
  return { ...user, scope: 'local', keys: ['projects', key, ...SERVERS] };
}

export function foundMarkers(cli: AgentCli, t: TargetEnv): string[] {
  switch (cli) {
    case 'claude':
      return [claudeUserFile(t), claudeDir(t) ?? pathsFor(t).join(t.homeDir, '.claude')];
    case 'codex':
      return [codexDir(t)];
    case 'cursor':
      return [cursorDir(t)];
    case 'opencode':
      return [openCodeDir(t)];
  }
}

export function openCodeJsoncPath(t: TargetEnv): string {
  return pathsFor(t).join(openCodeDir(t), 'opencode.jsonc');
}

/** Cursor project install is out of scope (spec §6). */
export function installableInProject(cli: AgentCli): boolean {
  return cli !== 'cursor';
}
