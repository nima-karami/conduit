import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import { buildLaunchSpec, type LaunchRequest } from '../../src/launch-spec';
import { resolveLaunchSpec } from '../../src/pty-host';
import type { AgentDefinition } from '../../src/types';

const agent = (id: string, command: string): AgentDefinition => ({
  id,
  label: id,
  command,
  args: ['--x'],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});
const registry = new AgentRegistry([agent('claude', 'claude'), agent('codex', 'codex')]);

const req = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
  registry,
  agentId: 'claude',
  cwd: '/live',
  home: '/home/p',
  homeMissing: false,
  roots: [],
  exists: () => true,
  resolveCommand: (c) => `/usr/bin/${c}`,
  platform: 'linux',
  ...over,
});

describe('buildLaunchSpec', () => {
  it('roots [] → spec equals resolveLaunchSpec for the same cwd', () => {
    for (const agentId of ['claude', 'codex', 'shell', undefined]) {
      const plan = buildLaunchSpec(req({ agentId }));
      const today = resolveLaunchSpec(registry, agentId, '/live', () => true, '/live');
      expect(plan).toMatchObject({ ok: true, spec: today });
    }
  });

  it('claude + 2 roots → both pairs; lists returned', () => {
    const plan = buildLaunchSpec(req({ roots: ['/a', '/b'] }));
    expect(plan).toEqual({
      ok: true,
      spec: {
        command: 'claude',
        args: ['--x', '--add-dir', '/a', '--add-dir', '/b'],
        cwd: '/live',
      },
      addDir: true,
      launchedRoots: ['/a', '/b'],
      skippedAddDirRoots: [],
    });
  });

  it('shell / unknown agent → addDir false, empty lists', () => {
    for (const agentId of ['shell', 'nope', 'codex', undefined]) {
      const plan = buildLaunchSpec(req({ agentId, roots: ['/a'] }));
      expect(plan, String(agentId)).toMatchObject({
        ok: true,
        addDir: false,
        launchedRoots: [],
        skippedAddDirRoots: [],
      });
      if (plan.ok) expect(plan.spec.args, String(agentId)).not.toContain('--add-dir');
    }
  });

  it('win32 .cmd guard reaches the plan', () => {
    const plan = buildLaunchSpec(
      req({
        platform: 'win32',
        cwd: 'C:\\p',
        home: 'C:\\p',
        roots: ['C:\\R&D'],
        resolveCommand: () => 'C:\\bin\\claude.cmd',
      }),
    );
    expect(plan).toMatchObject({ ok: true, launchedRoots: [], skippedAddDirRoots: ['C:\\R&D'] });
  });

  it('homeMissing → home-missing', () => {
    expect(buildLaunchSpec(req({ homeMissing: true }))).toEqual({
      ok: false,
      reason: 'home-missing',
    });
  });

  it('live cwd gone, home present → cwd home', () => {
    const plan = buildLaunchSpec(req({ exists: (p) => p === '/home/p' }));
    expect(plan.ok && plan.spec.cwd).toBe('/home/p');
  });

  it('both gone → home-missing', () => {
    expect(buildLaunchSpec(req({ exists: () => false }))).toEqual({
      ok: false,
      reason: 'home-missing',
    });
    expect(buildLaunchSpec(req({ cwd: undefined, exists: () => false }))).toEqual({
      ok: false,
      reason: 'home-missing',
    });
  });
});
