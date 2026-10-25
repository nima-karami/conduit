import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS, type McpAdapter, type McpAdapterId } from '../../src/conduit-mcp/adapters';
import { mcpLaunchWiring, mcpServerCommand } from '../../src/mcp-launch';

const adapter = (id: McpAdapterId): McpAdapter => {
  const a = MCP_ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(id);
  return a;
};

const EXE = 'C:\\Program Files\\Conduit\\Conduit.exe';
const SHIM = 'C:\\Program Files\\Conduit\\resources\\conduit-mcp\\conduit-mcp-shim.cjs';
const PIPE = '\\\\.\\pipe\\conduit-mcp-0123456789abcdef';
const CONFIG = 'C:\\Users\\A\\AppData\\Roaming\\Conduit\\conduit-mcp\\launch\\s1.json';

describe('mcpServerCommand', () => {
  it('runs the shim with the exe as node, env only on the server entry', () => {
    expect(mcpServerCommand(EXE, SHIM, PIPE)).toEqual({
      command: EXE,
      args: [SHIM, '--endpoint', PIPE],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });
});

describe('mcpLaunchWiring', () => {
  const server = mcpServerCommand(EXE, SHIM, PIPE);

  it('claude: --mcp-config with a generated config', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('claude'),
      platform: 'win32',
      resolvedCommand: 'C:\\bin\\claude.exe',
      server,
      configFile: CONFIG,
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.args).toEqual(['--mcp-config', CONFIG]);
    const cfg = JSON.parse(w.configJson ?? 'null');
    expect(cfg.mcpServers.conduit).toEqual({
      type: 'stdio',
      command: EXE,
      args: [SHIM, '--endpoint', PIPE],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(cfg.mcpServers.conduit.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('fake uses the same --mcp-config wiring', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('fake'),
      platform: 'linux',
      resolvedCommand: '/usr/bin/node',
      server,
      configFile: '/tmp/s1.json',
    });
    expect(w.ok && w.args).toEqual(['--mcp-config', '/tmp/s1.json']);
  });

  it('codex: exactly five -c pairs in order, TOML literal quoting', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('codex'),
      platform: 'win32',
      resolvedCommand: 'C:\\bin\\codex.exe',
      server,
      configFile: CONFIG,
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.configJson).toBeNull();
    expect(w.args).toEqual([
      '-c',
      `mcp_servers.conduit.command='${EXE}'`,
      '-c',
      `mcp_servers.conduit.args=['${SHIM}','--endpoint','${PIPE}']`,
      '-c',
      "mcp_servers.conduit.env={ELECTRON_RUN_AS_NODE='1'}",
      '-c',
      "mcp_servers.conduit.env_vars=['CONDUIT_SESSION_TOKEN']",
      '-c',
      "mcp_servers.conduit.default_tools_approval_mode='auto'",
    ]);
  });

  it('execPath containing a quote → unquotable-path', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('codex'),
      platform: 'linux',
      resolvedCommand: '/usr/bin/codex',
      server: mcpServerCommand("/opt/o'neil/conduit", '/opt/shim.cjs', '/tmp/x.sock'),
      configFile: '/tmp/s1.json',
    });
    expect(w).toEqual({ ok: false, reason: 'unquotable-path' });
  });

  it('a newline in a codex value → unquotable-path', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('codex'),
      platform: 'linux',
      resolvedCommand: '/usr/bin/codex',
      server: mcpServerCommand('/opt/conduit', '/opt/a\nb/shim.cjs', '/tmp/x.sock'),
      configFile: '/tmp/s1.json',
    });
    expect(w).toEqual({ ok: false, reason: 'unquotable-path' });
  });

  it('cursor: no args, no config', () => {
    expect(
      mcpLaunchWiring({
        adapter: adapter('cursor'),
        platform: 'win32',
        resolvedCommand: 'C:\\bin\\agent.cmd',
        server,
        configFile: CONFIG,
      }),
    ).toEqual({ ok: true, args: [], configJson: null });
  });

  it('win32 + .cmd + metachar in the config path → cmd-metachar', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('claude'),
      platform: 'win32',
      resolvedCommand: 'C:\\npm\\claude.cmd',
      server,
      configFile: 'C:\\Users\\A&B\\AppData\\Roaming\\Conduit\\conduit-mcp\\launch\\s1.json',
    });
    expect(w).toEqual({ ok: false, reason: 'cmd-metachar' });
  });

  it('win32 + unresolvable command + metachar → cmd-metachar', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('codex'),
      platform: 'win32',
      resolvedCommand: undefined,
      server: mcpServerCommand('C:\\100%\\Conduit.exe', SHIM, PIPE),
      configFile: CONFIG,
    });
    expect(w).toEqual({ ok: false, reason: 'cmd-metachar' });
  });

  it('win32 + .cmd without metachars → ok', () => {
    for (const id of ['claude', 'codex'] as const) {
      const w = mcpLaunchWiring({
        adapter: adapter(id),
        platform: 'win32',
        resolvedCommand: `C:\\npm\\${id}.cmd`,
        server,
        configFile: CONFIG,
      });
      expect(w.ok).toBe(true);
    }
  });

  it('posix never guarded', () => {
    const w = mcpLaunchWiring({
      adapter: adapter('claude'),
      platform: 'linux',
      resolvedCommand: undefined,
      server: mcpServerCommand('/opt/a&b/conduit', '/opt/a&b/shim.cjs', '/tmp/x!.sock'),
      configFile: '/home/a&b/s1.json',
    });
    expect(w.ok).toBe(true);
  });

  // The token value never reaching args or the config file is asserted in the host test, where
  // a token exists; here, only that no adapter assigns the variable itself.
  it('no adapter output assigns the session token', () => {
    for (const a of MCP_ADAPTERS) {
      const w = mcpLaunchWiring({
        adapter: a,
        platform: 'linux',
        resolvedCommand: '/usr/bin/x',
        server,
        configFile: '/tmp/s1.json',
      });
      expect(w.ok).toBe(true);
      if (!w.ok) continue;
      const text = `${w.args.join(' ')} ${w.configJson ?? ''}`;
      expect(text).not.toMatch(/CONDUIT_SESSION_TOKEN['"]?\s*[:=]/);
    }
  });
});
