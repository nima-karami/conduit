import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import { formatCommandLine } from '../../src/command-line';
import { previewLaunch } from '../../src/launch-preview';
import { buildLaunchSpec } from '../../src/launch-spec';
import type { AgentDefinition } from '../../src/types';

const def = (id: string, command: string): AgentDefinition => ({
  id,
  label: id,
  command,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

const HOME = 'C:\\src\\rmb';
const B = 'D:\\work\\ci image';
const GONE = 'D:\\gone';
const AMP = 'D:\\x&y';

type Deps = Parameters<typeof previewLaunch>[1];

function deps(over: Partial<Deps> = {}): Deps {
  const registry = new AgentRegistry([
    def('shell:pwsh', 'C:\\Windows\\pwsh.exe'),
    def('cli:claude', 'C:\\u\\.local\\bin\\claude.exe'),
    def('cli:claude-cmd', 'C:\\npm\\claude.cmd'),
    def('cli:codex', 'codex'),
  ]);
  const missing = new Set([GONE.toLowerCase()]);
  return {
    registry,
    probe: async (raw) =>
      typeof raw === 'string' && raw.startsWith('C:\\src')
        ? { status: 'present', stored: raw, key: raw, realKey: raw }
        : { status: 'missing', stored: String(raw), key: String(raw) },
    resolveInitialRoots: async (_home, roots) => {
      const list = Array.isArray(roots) ? (roots as string[]) : [];
      return {
        roots: list,
        missing: list.filter((r) => missing.has(r.toLowerCase())),
        dropped: [],
      };
    },
    exists: (p) => p === HOME,
    resolveCommand: (c) => (c === 'codex' ? undefined : c),
    platform: 'win32',
    ...over,
  };
}

describe('previewLaunch', () => {
  it('claude + present root → display "claude --add-dir <R>", cwd = home', async () => {
    const r = await previewLaunch({ agentId: 'cli:claude', home: HOME, roots: [B] }, deps());
    expect(r).toEqual({
      cwd: HOME,
      command: 'C:\\u\\.local\\bin\\claude.exe',
      args: ['--add-dir', B],
      display: `claude --add-dir "${B}"`,
      skippedAddDirRoots: [],
    });
  });

  it('missing root excluded from args', async () => {
    const r = await previewLaunch({ agentId: 'cli:claude', home: HOME, roots: [GONE, B] }, deps());
    expect(r.args).toEqual(['--add-dir', B]);
  });

  it('win32 claude.cmd + root x&y → skippedAddDirRoots [x&y], arg absent', async () => {
    const r = await previewLaunch(
      { agentId: 'cli:claude-cmd', home: HOME, roots: [AMP, B] },
      deps(),
    );
    expect(r.skippedAddDirRoots).toEqual([AMP]);
    expect(r.args).toEqual(['--add-dir', B]);
    expect(r.error).toBeUndefined();
  });

  it('claude.exe + x&y → passed', async () => {
    const r = await previewLaunch({ agentId: 'cli:claude', home: HOME, roots: [AMP] }, deps());
    expect(r.skippedAddDirRoots).toEqual([]);
    expect(r.args).toEqual(['--add-dir', AMP]);
  });

  it('home missing → error home-missing', async () => {
    const r = await previewLaunch({ agentId: 'cli:claude', home: 'D:\\nope', roots: [] }, deps());
    expect(r).toEqual({ error: 'home-missing', skippedAddDirRoots: [] });
  });

  it('unknown agent → unknown launcher', async () => {
    const r = await previewLaunch({ agentId: 'cli:gemini', home: HOME, roots: [] }, deps());
    expect(r).toEqual({ error: 'unknown launcher', skippedAddDirRoots: [] });
  });

  it('unresolvable command → not found on PATH with args filled', async () => {
    const r = await previewLaunch({ agentId: 'cli:codex', home: HOME, roots: [B] }, deps());
    expect(r).toEqual({
      error: 'not found on PATH',
      cwd: HOME,
      command: 'codex',
      args: [],
      skippedAddDirRoots: [],
    });
  });

  it('shell → shell display, no --add-dir', async () => {
    const r = await previewLaunch({ agentId: 'shell:pwsh', home: HOME, roots: [B] }, deps());
    expect(r.display).toBe('pwsh');
    expect(r.args).toEqual([]);
    expect(r.cwd).toBe(HOME);
  });

  it('non-string home → invalid request', async () => {
    expect(await previewLaunch({ agentId: 'cli:claude', home: 3, roots: [] }, deps())).toEqual({
      error: 'invalid request',
      skippedAddDirRoots: [],
    });
    expect(await previewLaunch({ agentId: null, home: HOME, roots: [] }, deps())).toEqual({
      error: 'invalid request',
      skippedAddDirRoots: [],
    });
  });

  it('display === formatCommandLine(buildLaunchSpec(same).spec)', async () => {
    const d = deps();
    const r = await previewLaunch({ agentId: 'cli:claude', home: HOME, roots: [B, GONE] }, d);
    const plan = buildLaunchSpec({
      registry: d.registry,
      agentId: 'cli:claude',
      cwd: undefined,
      home: HOME,
      homeMissing: false,
      roots: [B],
      exists: d.exists,
      resolveCommand: d.resolveCommand,
      platform: 'win32',
    });
    if (!plan.ok) throw new Error('plan refused');
    expect(r.display).toBe(formatCommandLine(plan.spec, 'win32'));
  });
});
