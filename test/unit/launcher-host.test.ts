import { describe, expect, it } from 'vitest';
import { LauncherHost, type LauncherHostDeps } from '../../electron/launcher-host';
import { AgentRegistry } from '../../src/agent-registry';
import { parseLaunchers, serializeLaunchers } from '../../src/launcher-store';
import type { AgentDefinition } from '../../src/types';

const def = (id: string, command = id, label = id): AgentDefinition => ({
  id,
  label,
  command,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

function setup(over: Partial<LauncherHostDeps> & { file?: string } = {}) {
  const writes: string[] = [];
  const backups: number[] = [];
  let clis = [def('cli:claude', 'C:\\b\\claude.exe', 'claude')];
  let clock = 100;
  const registry = new AgentRegistry([]);
  const deps: LauncherHostDeps = {
    registry,
    config: [],
    detectShells: () => [def('shell:pwsh', 'pwsh.exe', 'PowerShell 7')],
    detectClis: () => clis,
    readFile: () => over.file,
    persist: (t) => writes.push(t),
    backupCorrupt: () => backups.push(writes.length),
    resolveCommand: (c) => (c === 'aider' ? 'C:\\t\\aider.exe' : undefined),
    platform: 'win32',
    now: () => clock++,
    ...over,
  };
  const host = new LauncherHost(deps);
  return {
    host,
    registry,
    writes,
    backups,
    setClis: (next: AgentDefinition[]) => {
      clis = next;
    },
  };
}

describe('LauncherHost', () => {
  it('constructor composes shells+clis+config+custom into the registry', () => {
    const file = serializeLaunchers({ version: 1, usage: {}, custom: [def('custom:x', '/x')] });
    const { registry } = setup({ file, config: [def('my-codex', 'codex')] });
    expect(registry.list().map((d) => d.id)).toEqual([
      'shell:pwsh',
      'cli:claude',
      'my-codex',
      'custom:x',
    ]);
    expect(registry.get('cli:codex')?.id).toBe('my-codex');
  });

  it('rescan returns false when detection is unchanged, true and replaces when a CLI appears', () => {
    const { host, registry, setClis } = setup();
    expect(host.rescan()).toBe(false);
    setClis([
      def('cli:claude', 'C:\\b\\claude.exe', 'claude'),
      def('cli:codex', 'codex.exe', 'codex'),
    ]);
    expect(host.rescan()).toBe(true);
    expect(registry.get('cli:codex')?.command).toBe('codex.exe');
  });

  it('bump persists usage; dtos carry uses/lastUsed', () => {
    const { host, writes } = setup();
    host.bump('cli:claude');
    host.bump('cli:claude');
    expect(parseLaunchers(writes.at(-1)).usage['cli:claude']).toEqual({ count: 2, lastUsed: 101 });
    expect(host.dtos()).toEqual([
      { id: 'shell:pwsh', kind: 'shell', uses: 0 },
      { id: 'cli:claude', kind: 'cli', uses: 2, lastUsed: 101 },
    ]);
  });

  it('addCustom success persists, registers, returns id; error passes through', () => {
    const { host, registry, writes } = setup();
    const r = host.addCustom('aider --x', undefined);
    expect(r).toEqual({ ok: true, id: 'custom:aider' });
    expect(registry.get('custom:aider')?.args).toEqual(['--x']);
    expect(parseLaunchers(writes.at(-1)).custom.map((d) => d.id)).toEqual(['custom:aider']);
    expect(host.dtos().at(-1)).toEqual({ id: 'custom:aider', kind: 'custom', uses: 0 });
    expect(host.addCustom('nope', undefined)).toEqual({
      ok: false,
      error: 'Can\'t find "nope" on PATH',
    });
    expect(writes).toHaveLength(1);
  });

  it('addCustom takenIds/labels include every registry def', () => {
    const { host, registry } = setup({ config: [def('custom:aider', 'zzz', 'Aider')] });
    const r = host.addCustom('aider', undefined);
    expect(r).toEqual({ ok: true, id: 'custom:aider-2' });
    expect(registry.get('custom:aider-2')?.label).toBe('aider (2)');
  });

  it('removeCustom of a custom id unregisters and persists; other id → false', () => {
    const { host, registry, writes } = setup();
    host.addCustom('aider', undefined);
    expect(host.removeCustom('cli:claude')).toBe(false);
    expect(host.removeCustom('custom:aider')).toBe(true);
    expect(registry.get('custom:aider')).toBeUndefined();
    expect(parseLaunchers(writes.at(-1)).custom).toEqual([]);
  });

  it('pendingFlush null until a change', () => {
    const { host } = setup();
    expect(host.pendingFlush()).toBeNull();
    host.bump('shell:pwsh');
    expect(parseLaunchers(host.pendingFlush() ?? undefined).usage['shell:pwsh']?.count).toBe(1);
  });

  it('a bad launchers.json reads as empty', () => {
    const { host, registry } = setup({ file: '{not json' });
    expect(registry.list().map((d) => d.id)).toEqual(['shell:pwsh', 'cli:claude']);
    expect(host.dtos().every((d) => d.uses === 0)).toBe(true);
  });

  it('a corrupt launchers.json is backed up once, before the first overwrite', () => {
    const { host, backups, writes } = setup({ file: '{not json' });
    expect(backups).toEqual([]);
    host.bump('cli:claude');
    host.bump('cli:claude');
    expect(backups).toEqual([0]);
    expect(writes).toHaveLength(2);
  });

  it('a lossy launchers.json (an entry dropped on parse) is backed up too; an intact one is not', () => {
    const lossy = JSON.stringify({ version: 1, usage: {}, custom: [{ id: 'custom:broken' }] });
    const a = setup({ file: lossy });
    a.host.bump('cli:claude');
    expect(a.backups).toEqual([0]);
    const intact = serializeLaunchers({
      version: 1,
      usage: { x: { count: 1, lastUsed: 1 } },
      custom: [],
    });
    const b = setup({ file: intact });
    b.host.bump('cli:claude');
    expect(b.backups).toEqual([]);
  });
});
