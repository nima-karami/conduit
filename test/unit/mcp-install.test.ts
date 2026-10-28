import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigIo } from '../../electron/config-file-io';
import { createMcpInstall, type McpInstallDeps } from '../../electron/mcp-install';
import { claudeLocalTarget, projectTarget, userTarget } from '../../electron/mcp-install-targets';
import { conduitEntry } from '../../src/conduit-mcp/install-entries';
import type { AgentCli, CliInstallStatus } from '../../src/conduit-mcp/install-types';
import { readCodexConduit } from '../../src/conduit-mcp/toml-config';
import { folderKey } from '../../src/folder-key';

const roots: string[] = [];
function tmp(prefix = 'conduit-mcpi-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const execPath = '/app/conduit';
const shimPath = '/app/resources/conduit-mcp-shim.cjs';

interface Setup {
  home: string;
  userData: string;
  deps: McpInstallDeps;
  file(cli: AgentCli): string;
  seed(cli: AgentCli, text: string): string;
}

function setup(
  over: Partial<McpInstallDeps> & { onPathClis?: AgentCli[]; homes?: string[] } = {},
): Setup {
  const home = tmp();
  const userData = tmp();
  const onPathClis = new Set<AgentCli>(
    over.onPathClis ?? ['claude', 'codex', 'cursor', 'opencode'],
  );
  const homes = over.homes ?? [];
  const deps: McpInstallDeps = {
    homeDir: home,
    env: {},
    userDataDir: userData,
    platform: 'linux',
    execPath,
    shimPath,
    onPath: (cli) => onPathClis.has(cli),
    knownHome: (p) => homes.find((h) => folderKey(h) === folderKey(p)) ?? null,
    ...over,
  };
  const file = (cli: AgentCli) => userTarget(cli, deps).path;
  return {
    home,
    userData,
    deps,
    file,
    seed(cli, text) {
      const f = file(cli);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
      return f;
    },
  };
}

const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const statusOf = (s: { clis: CliInstallStatus[] }, cli: AgentCli) => {
  const found = s.clis.find((c) => c.cli === cli);
  if (!found) throw new Error(`no ${cli}`);
  return found;
};

const JSON_SEEDS: Record<Exclude<AgentCli, 'codex'>, { text: string; keys: string[] }> = {
  claude: {
    text: '{"mcpServers":{"other":{"command":"x"}},"numStartups":3}',
    keys: ['mcpServers', 'conduit'],
  },
  cursor: { text: '{"mcpServers":{"other":{"command":"y"}}}', keys: ['mcpServers', 'conduit'] },
  opencode: {
    text: '{"$schema":"https://opencode.ai/config.json","mcp":{"other":{"type":"local","command":["z"]}}}',
    keys: ['mcp', 'conduit'],
  },
};

const OLD_CODEX_TABLE = [
  '[mcp_servers.conduit]',
  'command = "/old/conduit"',
  'args = ["/old/conduit-mcp-shim.cjs"]',
  'env = { ELECTRON_RUN_AS_NODE = "1" }',
  'env_vars = ["CONDUIT_SESSION_TOKEN", "CONDUIT_MCP_ENDPOINT"]',
  'default_tools_approval_mode = "auto"',
  '',
].join('\n');

describe('status', () => {
  it('always four CLIs in catalog order; user paths from the targets', () => {
    const s = setup();
    const status = createMcpInstall(s.deps).status(null);
    expect(status.clis.map((c) => c.cli)).toEqual(['claude', 'codex', 'cursor', 'opencode']);
    for (const c of status.clis) {
      expect(c.user).toEqual({ state: 'not-installed', path: s.file(c.cli) });
      expect(c.project).toBeNull();
    }
  });

  it('found: PATH or marker; not-found → Check again only (install → ESTATE)', () => {
    const s = setup({ onPathClis: ['claude'] });
    fs.mkdirSync(path.join(s.home, '.codex'));
    const api = createMcpInstall(s.deps);
    const st = api.status(null);
    expect(statusOf(st, 'claude')).toMatchObject({ found: true, user: { state: 'not-installed' } });
    expect(statusOf(st, 'codex')).toMatchObject({ found: true, user: { state: 'not-installed' } });
    expect(statusOf(st, 'cursor')).toMatchObject({ found: false, user: { state: 'not-found' } });
    expect(statusOf(st, 'opencode').user.state).toBe('not-found');
    const r = api.act({ cli: 'cursor', scope: 'user', action: 'install' });
    expect(r).toMatchObject({ ok: false, errorCode: 'ESTATE' });
    expect(fs.existsSync(s.file('cursor'))).toBe(false);
  });

  it('resolves PATH once per CLI per status call', () => {
    const calls: AgentCli[] = [];
    const s = setup();
    const api = createMcpInstall({
      ...s.deps,
      onPath: (cli) => {
        calls.push(cli);
        return true;
      },
    });
    api.status(null);
    expect(calls).toEqual(['claude', 'codex', 'cursor', 'opencode']);
  });

  it('reads the Claude user file once per status call, even with a project', () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    const claudeFile = s.seed('claude', JSON.stringify({ projects: { [root]: {} } }));
    let reads = 0;
    const io: ConfigIo = {
      ...fs,
      readFileSync: ((p: fs.PathOrFileDescriptor, o?: unknown) => {
        if (typeof p === 'string' && path.resolve(p) === fs.realpathSync(claudeFile)) reads++;
        return fs.readFileSync(p, o as never);
      }) as typeof fs.readFileSync,
    };
    createMcpInstall({ ...s.deps, io }).status(root);
    expect(reads).toBe(1);
  });

  it('userState mirrors the user row', () => {
    const s = setup({ onPathClis: ['claude'] });
    s.seed('claude', '{"mcpServers":{"conduit":{"command":"npx","args":["x"]}}}');
    const api = createMcpInstall(s.deps);
    expect(api.userState('claude')).toBe('conflict');
    expect(api.userState('cursor')).toBe('not-found');
  });
});

describe('install (AC4)', () => {
  for (const cli of ['claude', 'cursor', 'opencode'] as const) {
    it(`${cli}: install on not-installed: backup once, only conduit added, others deep-equal`, () => {
      const s = setup();
      const { text, keys } = JSON_SEEDS[cli];
      const f = s.seed(cli, text);
      const api = createMcpInstall(s.deps);
      expect(statusOf(api.status(null), cli).user.state).toBe('not-installed');
      const r = api.act({ cli, scope: 'user', action: 'install' });
      expect(r).toMatchObject({ ok: true, status: { user: { state: 'installed' } } });
      const after = json(f);
      const [parent = '', leaf = ''] = keys;
      expect(after[parent][leaf]).toEqual(conduitEntry(cli, execPath, shimPath));
      delete after[parent][leaf];
      expect(after).toEqual(JSON.parse(text));
      const backup = `${f}.conduit-backup`;
      expect(fs.readFileSync(backup, 'utf8')).toBe(text);
      const backupMtime = fs.statSync(backup).mtimeMs;
      expect(api.act({ cli, scope: 'user', action: 'install' })).toMatchObject({ ok: true });
      expect(fs.statSync(backup).mtimeMs).toBe(backupMtime);
      expect(fs.readFileSync(backup, 'utf8')).toBe(text);
    });
  }

  it('codex: install on a missing file creates it; backup holds "null"', () => {
    const s = setup();
    const r = createMcpInstall(s.deps).act({ cli: 'codex', scope: 'user', action: 'install' });
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(s.file('codex'), 'utf8');
    expect(readCodexConduit(text)).toEqual(conduitEntry('codex', execPath, shimPath));
    expect(fs.readFileSync(`${s.file('codex')}.conduit-backup`, 'utf8')).toBe('null');
  });

  it('TOML install keeps bytes outside the owned range identical', () => {
    const s = setup();
    const before = '# mine\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n';
    const after = '\n[profiles.a]\nk = 1 # keep me\n';
    const f = s.seed('codex', before + OLD_CODEX_TABLE + after);
    const api = createMcpInstall(s.deps);
    expect(statusOf(api.status(null), 'codex').user.state).toBe('other-conduit');
    expect(api.act({ cli: 'codex', scope: 'user', action: 'install' }).ok).toBe(true);
    const text = fs.readFileSync(f, 'utf8');
    expect(text.startsWith(before)).toBe(true);
    expect(text.endsWith(after)).toBe(true);
    expect(readCodexConduit(text)).toEqual(conduitEntry('codex', execPath, shimPath));
  });

  it('TOML keeps a BOM; JSON drops it', () => {
    const s = setup();
    const bom = String.fromCharCode(0xfeff);
    const codex = s.seed('codex', `${bom}model = "o3"\n`);
    const claude = s.seed('claude', `${bom}{"a":1}`);
    const api = createMcpInstall(s.deps);
    expect(api.act({ cli: 'codex', scope: 'user', action: 'install' }).ok).toBe(true);
    expect(api.act({ cli: 'claude', scope: 'user', action: 'install' }).ok).toBe(true);
    expect(fs.readFileSync(codex, 'utf8').charCodeAt(0)).toBe(0xfeff);
    expect(fs.readFileSync(claude, 'utf8').charCodeAt(0)).toBe('{'.charCodeAt(0));
  });

  it.skipIf(process.platform === 'win32')('install preserves the file mode', () => {
    const s = setup();
    const f = s.seed('claude', '{}');
    fs.chmodSync(f, 0o600);
    createMcpInstall(s.deps).act({ cli: 'claude', scope: 'user', action: 'install' });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('project install backs up under userData and writes nothing else in the repo', () => {
    for (const cli of ['claude', 'codex', 'opencode'] as const) {
      const root = tmp('conduit-proj-');
      const s = setup({ homes: [root] });
      const api = createMcpInstall(s.deps);
      const before = statusOf(api.status(root), cli).project;
      const target = projectTarget(cli, root, s.deps);
      expect(before).toEqual({ entries: [], installable: true, installPath: target.path });
      const r = api.act({ cli, scope: 'project', action: 'install', projectPath: root });
      expect(r.ok).toBe(true);
      expect(r.status.project?.entries).toEqual([
        { scope: 'project', state: 'ours', path: target.path },
      ]);
      expect(r.status.project?.installable).toBe(false);
      const top = path.relative(root, target.path).split(/[/\\]/)[0];
      expect(fs.readdirSync(root)).toEqual([top]);
      expect(fs.existsSync(target.backupPath)).toBe(true);
      expect(target.backupPath.startsWith(s.userData)).toBe(true);
    }
  });

  it('cursor is never installable in a project', () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    const api = createMcpInstall(s.deps);
    expect(statusOf(api.status(root), 'cursor').project).toMatchObject({
      installable: false,
      installPath: null,
    });
    expect(
      api.act({ cli: 'cursor', scope: 'project', action: 'install', projectPath: root }),
    ).toMatchObject({ ok: false, errorCode: 'ESTATE' });
  });
});

describe('errors (AC5)', () => {
  const cases: [string, AgentCli, string, string][] = [
    ['invalid JSON', 'claude', '{"mcpServers": ', 'EJSON'],
    ['JSONC', 'cursor', '{ // c\n "mcpServers": {} }', 'EJSON'],
    ['invalid TOML', 'codex', '[mcp_servers\n', 'ETOML'],
    ['uneditable TOML', 'codex', '[mcp_servers]\nconduit = { command = "x" }\n', 'EUNEDITABLE'],
  ];
  for (const [name, cli, text, code] of cases) {
    it(`${name} → error ${code}, file untouched`, () => {
      const s = setup();
      const f = s.seed(cli, text);
      const api = createMcpInstall(s.deps);
      expect(statusOf(api.status(null), cli).user).toMatchObject({
        state: 'error',
        errorCode: code,
      });
      const r = api.act({ cli, scope: 'user', action: 'install' });
      expect(r).toMatchObject({ ok: false, errorCode: code, status: { user: { state: 'error' } } });
      expect(fs.readFileSync(f, 'utf8')).toBe(text);
      expect(fs.existsSync(`${f}.conduit-backup`)).toBe(false);
    });
  }

  it('opencode.jsonc present → error EJSONC, nothing written', () => {
    const s = setup();
    const f = s.seed('opencode', '{}');
    fs.writeFileSync(path.join(path.dirname(f), 'opencode.jsonc'), '{}');
    const api = createMcpInstall(s.deps);
    expect(statusOf(api.status(null), 'opencode').user).toMatchObject({
      state: 'error',
      errorCode: 'EJSONC',
    });
    expect(api.act({ cli: 'opencode', scope: 'user', action: 'install' })).toMatchObject({
      ok: false,
      errorCode: 'EJSONC',
    });
    expect(fs.readFileSync(f, 'utf8')).toBe('{}');
  });

  it('guard failure → EGUARD, file untouched', () => {
    const s = setup();
    // A multi-line string holding a header-like line: the splice would cut through it.
    const text = 'note = """\n[mcp_servers.conduit]\n"""\n';
    const f = s.seed('codex', text);
    const api = createMcpInstall(s.deps);
    const r = api.act({ cli: 'codex', scope: 'user', action: 'install' });
    expect(r).toMatchObject({ ok: false, errorCode: 'EGUARD' });
    expect(fs.readFileSync(f, 'utf8')).toBe(text);
  });

  it('a non-object mcpServers is an error and is not overwritten', () => {
    const s = setup();
    const f = s.seed('claude', '{"mcpServers":[]}');
    const r = createMcpInstall(s.deps).act({ cli: 'claude', scope: 'user', action: 'install' });
    expect(r).toMatchObject({ ok: false });
    expect(fs.readFileSync(f, 'utf8')).toBe('{"mcpServers":[]}');
  });
});

describe('conflict and other-conduit (AC6)', () => {
  it('conflict: install → ESTATE; replace → written', () => {
    const s = setup();
    const f = s.seed('claude', '{"mcpServers":{"conduit":{"command":"npx","args":["thing"]}}}');
    const api = createMcpInstall(s.deps);
    expect(api.act({ cli: 'claude', scope: 'user', action: 'install' })).toMatchObject({
      ok: false,
      errorCode: 'ESTATE',
      status: { user: { state: 'conflict' } },
    });
    expect(json(f).mcpServers.conduit.command).toBe('npx');
    expect(api.act({ cli: 'claude', scope: 'user', action: 'replace' })).toMatchObject({
      ok: true,
      status: { user: { state: 'installed' } },
    });
    expect(json(f).mcpServers.conduit).toEqual(conduitEntry('claude', execPath, shimPath));
  });

  it('replace on not-installed → ESTATE', () => {
    const s = setup();
    expect(
      createMcpInstall(s.deps).act({ cli: 'claude', scope: 'user', action: 'replace' }),
    ).toMatchObject({ ok: false, errorCode: 'ESTATE' });
  });

  it('other-conduit: install rewrites without confirm', () => {
    const s = setup();
    const old = conduitEntry('claude', '/old/conduit', '/old/conduit-mcp-shim.cjs');
    const f = s.seed('claude', JSON.stringify({ mcpServers: { conduit: old } }));
    const api = createMcpInstall(s.deps);
    expect(statusOf(api.status(null), 'claude').user.state).toBe('other-conduit');
    expect(api.act({ cli: 'claude', scope: 'user', action: 'install' }).ok).toBe(true);
    expect(json(f).mcpServers.conduit).toEqual(conduitEntry('claude', execPath, shimPath));
  });

  it('cursor row: other-conduit vs conflict split', () => {
    const s = setup();
    const old = conduitEntry('cursor', '/old/conduit', '/old/conduit-mcp-shim.cjs');
    s.seed('cursor', JSON.stringify({ mcpServers: { conduit: old } }));
    const api = createMcpInstall(s.deps);
    expect(api.userState('cursor')).toBe('other-conduit');
    s.seed('cursor', JSON.stringify({ mcpServers: { conduit: { url: 'http://x' } } }));
    expect(api.userState('cursor')).toBe('conflict');
  });
});

describe('uninstall and remove (AC7)', () => {
  it('uninstall removes only conduit from installed/other-conduit; never deletes the file or the backup; empty mcpServers stays {}', () => {
    const s = setup();
    const f = s.seed('claude', '{"numStartups":1}');
    const api = createMcpInstall(s.deps);
    api.act({ cli: 'claude', scope: 'user', action: 'install' });
    expect(api.act({ cli: 'claude', scope: 'user', action: 'uninstall' })).toMatchObject({
      ok: true,
      status: { user: { state: 'not-installed' } },
    });
    expect(json(f)).toEqual({ numStartups: 1, mcpServers: {} });
    expect(fs.existsSync(`${f}.conduit-backup`)).toBe(true);

    const old = conduitEntry('cursor', '/old/conduit', '/old/conduit-mcp-shim.cjs');
    const c = s.seed('cursor', JSON.stringify({ mcpServers: { conduit: old, keep: {} } }));
    expect(api.act({ cli: 'cursor', scope: 'user', action: 'uninstall' }).ok).toBe(true);
    expect(json(c)).toEqual({ mcpServers: { keep: {} } });

    const codex = s.seed('codex', `a = 1\n\n${OLD_CODEX_TABLE}`);
    expect(api.act({ cli: 'codex', scope: 'user', action: 'uninstall' }).ok).toBe(true);
    expect(readCodexConduit(fs.readFileSync(codex, 'utf8'))).toBeUndefined();
    expect(fs.readFileSync(codex, 'utf8').startsWith('a = 1\n')).toBe(true);
  });

  it('uninstall on not-installed or conflict → ESTATE', () => {
    const s = setup();
    const api = createMcpInstall(s.deps);
    expect(api.act({ cli: 'claude', scope: 'user', action: 'uninstall' })).toMatchObject({
      ok: false,
      errorCode: 'ESTATE',
    });
    const f = s.seed('claude', '{"mcpServers":{"conduit":{"command":"npx"}}}');
    expect(api.act({ cli: 'claude', scope: 'user', action: 'uninstall' })).toMatchObject({
      ok: false,
      errorCode: 'ESTATE',
    });
    expect(json(f).mcpServers.conduit).toEqual({ command: 'npx' });
  });

  it("project remove deletes only that scope's entry", () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    const key = `${root.replace(/\\/g, '/')}/`;
    const ours = conduitEntry('claude', execPath, shimPath);
    const claudeFile = s.seed(
      'claude',
      JSON.stringify({
        mcpServers: { conduit: ours },
        projects: { [key]: { mcpServers: { conduit: ours, keep: { command: 'k' } } } },
      }),
    );
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { conduit: ours } }),
    );
    const api = createMcpInstall(s.deps);
    const project = statusOf(api.status(root), 'claude').project;
    const local = claudeLocalTarget(root, json(claudeFile), s.deps);
    expect(local?.keys[1]).toBe(key);
    expect(project?.entries).toEqual([
      { scope: 'local', state: 'ours', path: local?.path },
      { scope: 'project', state: 'ours', path: projectTarget('claude', root, s.deps).path },
    ]);
    const r = api.act({
      cli: 'claude',
      scope: 'project',
      action: 'remove',
      projectPath: root,
      entryScope: 'local',
    });
    expect(r.ok).toBe(true);
    const after = json(claudeFile);
    expect(after.projects[key].mcpServers).toEqual({ keep: { command: 'k' } });
    expect(after.mcpServers.conduit).toEqual(ours);
    expect(json(path.join(root, '.mcp.json')).mcpServers.conduit).toEqual(ours);
    expect(r.status.project?.entries.map((e) => e.scope)).toEqual(['project']);

    expect(
      api.act({
        cli: 'claude',
        scope: 'project',
        action: 'remove',
        projectPath: root,
        entryScope: 'local',
      }),
    ).toMatchObject({ ok: false, errorCode: 'ESTATE' });
    expect(
      api.act({
        cli: 'claude',
        scope: 'project',
        action: 'remove',
        projectPath: root,
        entryScope: 'project',
      }).ok,
    ).toBe(true);
    expect(json(path.join(root, '.mcp.json'))).toEqual({ mcpServers: {} });
  });

  it('remove of a conflict project entry → ESTATE', () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    fs.writeFileSync(path.join(root, 'opencode.json'), '{"mcp":{"conduit":{"type":"remote"}}}');
    const api = createMcpInstall(s.deps);
    expect(statusOf(api.status(root), 'opencode').project?.entries).toEqual([
      { scope: 'project', state: 'conflict', path: projectTarget('opencode', root, s.deps).path },
    ]);
    expect(
      api.act({
        cli: 'opencode',
        scope: 'project',
        action: 'remove',
        projectPath: root,
        entryScope: 'project',
      }),
    ).toMatchObject({ ok: false, errorCode: 'ESTATE' });
  });
});

describe('mtime guard (AC8)', () => {
  function racingIo(
    file: string,
    times: number,
    write: (n: number) => unknown = (n) => ({ other: `writer-${n}`.repeat(n) }),
  ): ConfigIo {
    let left = times;
    return {
      ...fs,
      readFileSync: ((p: fs.PathOrFileDescriptor, o?: unknown) => {
        const out = fs.readFileSync(p, o as never);
        if (left > 0 && typeof p === 'string' && path.resolve(p) === fs.realpathSync(file)) {
          left--;
          // Another writer lands between our read and our rename.
          fs.writeFileSync(file, JSON.stringify(write(times - left)));
        }
        return out;
      }) as typeof fs.readFileSync,
    };
  }
  const USER_ENTRY = { command: 'my-own-conduit', args: [] };

  it('uninstall raced by a writer that makes conduit user-authored → ESTATE, their entry kept', () => {
    const s = setup();
    const f = s.seed(
      'claude',
      JSON.stringify({ mcpServers: { conduit: conduitEntry('claude', execPath, shimPath) } }),
    );
    const api = createMcpInstall({
      ...s.deps,
      io: racingIo(f, 1, () => ({ mcpServers: { conduit: USER_ENTRY } })),
    });
    const r = api.act({ cli: 'claude', scope: 'user', action: 'uninstall' });
    expect(r).toMatchObject({
      ok: false,
      errorCode: 'ESTATE',
      status: { user: { state: 'conflict' } },
    });
    expect(json(f)).toEqual({ mcpServers: { conduit: USER_ENTRY } });
  });

  it('install raced by a writer that adds a user-authored conduit → ESTATE, not overwritten', () => {
    const s = setup();
    const f = s.seed('claude', '{}');
    const api = createMcpInstall({
      ...s.deps,
      io: racingIo(f, 1, () => ({ mcpServers: { conduit: USER_ENTRY } })),
    });
    const r = api.act({ cli: 'claude', scope: 'user', action: 'install' });
    expect(r).toMatchObject({
      ok: false,
      errorCode: 'ESTATE',
      status: { user: { state: 'conflict' } },
    });
    expect(json(f)).toEqual({ mcpServers: { conduit: USER_ENTRY } });
  });

  it('install raced by a writer that installs the same entry → ok, their write left as is', () => {
    const s = setup();
    const f = s.seed('claude', '{}');
    const theirs = { n: 1, mcpServers: { conduit: conduitEntry('claude', execPath, shimPath) } };
    const api = createMcpInstall({ ...s.deps, io: racingIo(f, 1, () => theirs) });
    const r = api.act({ cli: 'claude', scope: 'user', action: 'install' });
    expect(r).toMatchObject({ ok: true, status: { user: { state: 'installed' } } });
    expect(json(f)).toEqual(theirs);
  });

  it('replace raced by a writer that swaps in a different user entry → ESTATE, theirs kept', () => {
    const s = setup();
    const f = s.seed('claude', JSON.stringify({ mcpServers: { conduit: USER_ENTRY } }));
    const newer = { command: 'newer-conduit', args: [] };
    const api = createMcpInstall({
      ...s.deps,
      io: racingIo(f, 1, () => ({ mcpServers: { conduit: newer } })),
    });
    const r = api.act({ cli: 'claude', scope: 'user', action: 'replace' });
    expect(r).toMatchObject({ ok: false, errorCode: 'ESTATE' });
    expect(json(f)).toEqual({ mcpServers: { conduit: newer } });
  });

  it('changed once → re-applied', () => {
    const s = setup();
    const f = s.seed('claude', '{"first":true}');
    const api = createMcpInstall({ ...s.deps, io: racingIo(f, 1) });
    const r = api.act({ cli: 'claude', scope: 'user', action: 'install' });
    expect(r).toMatchObject({ ok: true, status: { user: { state: 'installed' } } });
    expect(json(f)).toEqual({
      other: 'writer-1',
      mcpServers: { conduit: conduitEntry('claude', execPath, shimPath) },
    });
  });

  it("changed twice → EBUSY and the file holds the other writer's content", () => {
    const s = setup();
    const f = s.seed('claude', '{"first":true}');
    const api = createMcpInstall({ ...s.deps, io: racingIo(f, 2) });
    const r = api.act({ cli: 'claude', scope: 'user', action: 'install' });
    expect(r).toMatchObject({ ok: false, errorCode: 'EBUSY' });
    expect(json(f)).toEqual({ other: 'writer-2writer-2' });
  });

  it("no guard for files other than Claude's", () => {
    const s = setup();
    const f = s.seed('cursor', '{"first":true}');
    const api = createMcpInstall({ ...s.deps, io: racingIo(f, 2) });
    expect(api.act({ cli: 'cursor', scope: 'user', action: 'install' }).ok).toBe(true);
  });
});

describe('projects (AC9)', () => {
  it('unknown projectPath: status project null; act EPROJECT', () => {
    const s = setup({ homes: [] });
    const root = tmp('conduit-proj-');
    const api = createMcpInstall(s.deps);
    expect(statusOf(api.status(root), 'claude').project).toBeNull();
    expect(
      api.act({ cli: 'claude', scope: 'project', action: 'install', projectPath: root }),
    ).toMatchObject({ ok: false, errorCode: 'EPROJECT' });
    expect(api.act({ cli: 'claude', scope: 'project', action: 'install' })).toMatchObject({
      ok: false,
      errorCode: 'EPROJECT',
    });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('shadowedBy: a non-ours local Claude entry shadows the user row', () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    const ours = conduitEntry('claude', execPath, shimPath);
    s.seed(
      'claude',
      JSON.stringify({
        mcpServers: { conduit: ours },
        projects: { [root]: { mcpServers: { conduit: { command: 'npx' } } } },
      }),
    );
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      '{"mcpServers":{"conduit":{"command":"other"}}}',
    );
    const st = statusOf(createMcpInstall(s.deps).status(root), 'claude');
    expect(st.user).toMatchObject({ state: 'installed', shadowedBy: 'local' });
    expect(
      statusOf(createMcpInstall(s.deps).status(null), 'claude').user.shadowedBy,
    ).toBeUndefined();
  });

  it('shadowedBy: codex project entry; ours does not shadow; opencode never', () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      '[mcp_servers.conduit]\ncommand = "x"\n',
    );
    fs.writeFileSync(path.join(root, 'opencode.json'), '{"mcp":{"conduit":{"type":"remote"}}}');
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { conduit: conduitEntry('claude', execPath, shimPath) } }),
    );
    const st = createMcpInstall(s.deps).status(root);
    expect(statusOf(st, 'codex').user.shadowedBy).toBe('project');
    expect(statusOf(st, 'opencode').user.shadowedBy).toBeUndefined();
    expect(statusOf(st, 'claude').user.shadowedBy).toBeUndefined();
  });

  it('a broken project file is an error entry and blocks project install', () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    fs.writeFileSync(path.join(root, '.mcp.json'), '{nope');
    const api = createMcpInstall(s.deps);
    expect(statusOf(api.status(root), 'claude').project).toEqual({
      entries: [
        {
          scope: 'project',
          state: 'error',
          errorCode: 'EJSON',
          path: projectTarget('claude', root, s.deps).path,
        },
      ],
      installable: false,
      installPath: null,
    });
  });
});

describe('repair (D2)', () => {
  it('Repair rewrites an other-conduit entry whose shim is gone; leaves one whose paths exist', () => {
    const s = setup();
    const live = tmp('conduit-live-');
    const liveExe = path.join(live, 'conduit.exe');
    const liveShim = path.join(live, 'conduit-mcp-shim.cjs');
    fs.writeFileSync(liveExe, '');
    fs.writeFileSync(liveShim, '');
    const dead = conduitEntry('claude', liveExe, '/gone/conduit-mcp-shim.cjs');
    const claude = s.seed('claude', JSON.stringify({ mcpServers: { conduit: dead } }));
    const otherBuild = conduitEntry('cursor', liveExe, liveShim);
    const cursor = s.seed('cursor', JSON.stringify({ mcpServers: { conduit: otherBuild } }));
    const cursorBytes = fs.readFileSync(cursor, 'utf8');
    const rows = createMcpInstall(s.deps).repair();
    expect(rows).toEqual([{ cli: 'claude', path: s.file('claude') }]);
    // Only the dead part is replaced: the live exe stays.
    expect(json(claude).mcpServers.conduit).toEqual(conduitEntry('claude', liveExe, shimPath));
    expect(fs.readFileSync(`${claude}.conduit-backup`, 'utf8')).toBe(
      JSON.stringify({ mcpServers: { conduit: dead } }),
    );
    expect(fs.readFileSync(cursor, 'utf8')).toBe(cursorBytes);
  });

  it('Repair rewrites when the exe is gone; ignores conflict and installed entries', () => {
    const s = setup();
    const live = tmp('conduit-live-');
    const liveShim = path.join(live, 'conduit-mcp-shim.cjs');
    fs.writeFileSync(liveShim, '');
    const deadExe = conduitEntry('opencode', '/gone/conduit.exe', liveShim);
    s.seed('opencode', JSON.stringify({ mcp: { conduit: deadExe } }));
    s.seed('claude', '{"mcpServers":{"conduit":{"command":"/gone/x","args":["/gone/y"]}}}');
    s.seed(
      'cursor',
      JSON.stringify({ mcpServers: { conduit: conduitEntry('cursor', execPath, shimPath) } }),
    );
    const rows = createMcpInstall(s.deps).repair();
    expect(rows).toEqual([{ cli: 'opencode', path: s.file('opencode') }]);
  });

  it('Repair of an OpenCode entry without ELECTRON_RUN_AS_NODE adds it under `environment`', () => {
    const s = setup();
    const live = tmp('conduit-live-');
    const liveShim = path.join(live, 'conduit-mcp-shim.cjs');
    fs.writeFileSync(liveShim, '');
    const base = conduitEntry('opencode', '/gone/conduit.exe', liveShim) as {
      environment: Record<string, string>;
    };
    const environment = {
      ...Object.fromEntries(
        Object.entries(base.environment).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'),
      ),
      FOO: '1',
    };
    const file = s.seed('opencode', JSON.stringify({ mcp: { conduit: { ...base, environment } } }));
    expect(createMcpInstall(s.deps).repair()).toEqual([{ cli: 'opencode', path: file }]);
    const written = json(file).mcp.conduit;
    expect(written.command[0]).toBe(execPath);
    expect(written.environment).toEqual({ ...environment, ELECTRON_RUN_AS_NODE: '1' });
    expect(written).not.toHaveProperty('env');
  });

  it('Repair rewrites only the exe and shim paths; the user keys of the entry survive', () => {
    const s = setup();
    const codex = s.seed(
      'codex',
      `${OLD_CODEX_TABLE}enabled = false\nstartup_timeout_sec = 20\n`.replace(
        'args = ["/old/conduit-mcp-shim.cjs"]',
        'args = ["/old/conduit-mcp-shim.cjs", "--verbose"]',
      ),
    );
    const dead = conduitEntry('claude', '/gone/conduit', '/gone/conduit-mcp-shim.cjs');
    const claude = s.seed(
      'claude',
      JSON.stringify({
        mcpServers: { conduit: { ...dead, env: { ...(dead as { env: object }).env, FOO: '1' } } },
      }),
    );
    const rows = createMcpInstall(s.deps).repair();
    expect(rows.map((r) => r.cli).sort()).toEqual(['claude', 'codex']);
    expect(readCodexConduit(fs.readFileSync(codex, 'utf8'))).toEqual({
      ...conduitEntry('codex', execPath, shimPath),
      args: [shimPath, '--verbose'],
      enabled: false,
      startup_timeout_sec: 20,
    });
    const want = conduitEntry('claude', execPath, shimPath) as { env: object };
    expect(json(claude).mcpServers.conduit).toEqual({ ...want, env: { ...want.env, FOO: '1' } });
  });

  it('SF-2 Repair of `node <dead shim>` retargets the shim and keeps the runner', () => {
    const s = setup();
    const ours = conduitEntry('claude', execPath, shimPath) as { env: Record<string, string> };
    const { ELECTRON_RUN_AS_NODE: _, ...identity } = ours.env;
    const old = {
      type: 'stdio',
      command: 'node',
      args: ['/gone/conduit-mcp-shim.cjs'],
      env: identity,
    };
    const claude = s.seed('claude', JSON.stringify({ mcpServers: { conduit: old } }));
    expect(createMcpInstall(s.deps).repair()).toEqual([{ cli: 'claude', path: s.file('claude') }]);
    expect(json(claude).mcpServers.conduit).toEqual({ ...old, args: [shimPath] });
  });

  it('SF-2 Repair of `<dead exe> <shim>` points at the Conduit exe and runs it as node', () => {
    const s = setup();
    const live = tmp('conduit-live-');
    const liveShim = path.join(live, 'conduit-mcp-shim.cjs');
    fs.writeFileSync(liveShim, '');
    const ours = conduitEntry('claude', execPath, shimPath) as { env: Record<string, string> };
    const { ELECTRON_RUN_AS_NODE: _, ...identity } = ours.env;
    const old = { type: 'stdio', command: '/gone/conduit', args: [liveShim], env: identity };
    const claude = s.seed('claude', JSON.stringify({ mcpServers: { conduit: old } }));
    const codex = s.seed(
      'codex',
      OLD_CODEX_TABLE.replace('"/old/conduit-mcp-shim.cjs"', JSON.stringify(liveShim)).replace(
        'env = { ELECTRON_RUN_AS_NODE = "1" }\n',
        '',
      ),
    );
    const rows = createMcpInstall(s.deps).repair();
    expect(rows.map((r) => r.cli).sort()).toEqual(['claude', 'codex']);
    expect(json(claude).mcpServers.conduit).toEqual({
      ...old,
      command: execPath,
      env: { ...identity, ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(readCodexConduit(fs.readFileSync(codex, 'utf8'))).toEqual(
      conduitEntry('codex', execPath, liveShim),
    );
  });

  it('Repair reports a failed write as a row with its code', () => {
    const s = setup();
    const dead = conduitEntry('claude', '/gone/conduit', '/gone/conduit-mcp-shim.cjs');
    s.seed('claude', JSON.stringify({ mcpServers: { conduit: dead } }));
    const io: ConfigIo = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      },
    };
    expect(createMcpInstall({ ...s.deps, io }).repair()).toEqual([
      { cli: 'claude', path: s.file('claude'), errorCode: 'EPERM' },
    ]);
  });

  it('Repair never touches project files', () => {
    const root = tmp('conduit-proj-');
    const s = setup({ homes: [root] });
    const dead = conduitEntry('claude', '/gone/conduit', '/gone/conduit-mcp-shim.cjs');
    const projectText = JSON.stringify({ mcpServers: { conduit: dead } });
    fs.writeFileSync(path.join(root, '.mcp.json'), projectText);
    const key = root;
    const userText = JSON.stringify({ projects: { [key]: { mcpServers: { conduit: dead } } } });
    const claude = s.seed('claude', userText);
    expect(createMcpInstall(s.deps).repair()).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(projectText);
    expect(fs.readFileSync(claude, 'utf8')).toBe(userText);
  });
});

// Counterparts of the Cursor connect cases deleted with that module (plan T4.9).
describe('write failures and no-op installs (Cursor connect parity)', () => {
  const failingWrite = (nth: number) => {
    let writes = 0;
    return new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'writeFileSync') {
          return (...args: Parameters<typeof fs.writeFileSync>) => {
            writes += 1;
            if (writes === nth) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            return fs.writeFileSync(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as ConfigIo;
  };

  it('an existing empty config is backed up verbatim', () => {
    const s = setup();
    const f = s.seed('cursor', '{}');
    expect(
      createMcpInstall(s.deps).act({ cli: 'cursor', scope: 'user', action: 'install' }).ok,
    ).toBe(true);
    expect(fs.readFileSync(`${f}.conduit-backup`, 'utf8')).toBe('{}');
  });

  it('install on an installed entry neither backs up nor rewrites', () => {
    const s = setup();
    const original = JSON.stringify({
      mcpServers: { conduit: conduitEntry('cursor', execPath, shimPath) },
    });
    const f = s.seed('cursor', original);
    const r = createMcpInstall(s.deps).act({ cli: 'cursor', scope: 'user', action: 'install' });
    expect(r).toMatchObject({ ok: true, status: { user: { state: 'installed' } } });
    expect(fs.readFileSync(f, 'utf8')).toBe(original);
    expect(fs.existsSync(`${f}.conduit-backup`)).toBe(false);
  });

  it('a failed backup write reports its code and leaves the config, and no temp, behind', () => {
    const s = setup();
    const original = '{"mcpServers":{"keep":{"command":"x"}}}';
    const f = s.seed('cursor', original);
    const r = createMcpInstall({ ...s.deps, io: failingWrite(1) }).act({
      cli: 'cursor',
      scope: 'user',
      action: 'install',
    });
    expect(r).toMatchObject({
      ok: false,
      errorCode: 'ENOSPC',
      status: { user: { state: 'not-installed' } },
    });
    expect(fs.readFileSync(f, 'utf8')).toBe(original);
    expect(fs.existsSync(`${f}.conduit-backup`)).toBe(false);
    expect(fs.readdirSync(path.dirname(f)).some((n) => n.includes('.tmp'))).toBe(false);
  });

  it('a failed config write keeps the backup of the original', () => {
    const s = setup();
    const original = '{"mcpServers":{"keep":{"command":"x"}}}';
    const f = s.seed('cursor', original);
    const r = createMcpInstall({ ...s.deps, io: failingWrite(2) }).act({
      cli: 'cursor',
      scope: 'user',
      action: 'install',
    });
    expect(r).toMatchObject({ ok: false, errorCode: 'ENOSPC' });
    expect(fs.readFileSync(f, 'utf8')).toBe(original);
    expect(fs.readFileSync(`${f}.conduit-backup`, 'utf8')).toBe(original);
  });
});
