import { describe, expect, it } from 'vitest';
import {
  addCustomLauncher,
  bumpUsage,
  type LaunchersFile,
  parseLaunchers,
  removeCustomLauncher,
  serializeLaunchers,
} from '../../src/launcher-store';
import type { AgentDefinition } from '../../src/types';

const empty = (): LaunchersFile => ({ version: 1, usage: {}, custom: [] });

const custom = (id: string, label = id): AgentDefinition => ({
  id,
  label,
  command: 'C:\\bin\\x.exe',
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

const deps = (over: Partial<Parameters<typeof addCustomLauncher>[2]> = {}) => ({
  platform: 'win32' as const,
  resolveCommand: (c: string) => (c === 'aider' ? 'C:\\tools\\aider.exe' : undefined),
  takenIds: new Set<string>(),
  takenLabels: [] as string[],
  ...over,
});

describe('parseLaunchers', () => {
  it('undefined / not JSON / version 2 → empty file', () => {
    expect(parseLaunchers(undefined)).toEqual(empty());
    expect(parseLaunchers('{nope')).toEqual(empty());
    expect(
      parseLaunchers(JSON.stringify({ version: 2, usage: { a: { count: 1, lastUsed: 1 } } })),
    ).toEqual(empty());
    expect(parseLaunchers(JSON.stringify([1, 2]))).toEqual(empty());
  });

  it('bad usage entries dropped, non-custom ids dropped', () => {
    const blob = JSON.stringify({
      version: 1,
      usage: {
        good: { count: 2, lastUsed: 5 },
        nan: { count: 'x', lastUsed: 5 },
        inf: { count: 1, lastUsed: null },
        str: 'x',
      },
      custom: [custom('custom:a'), custom('shell:pwsh'), { id: 'custom:b' }, custom('custom:c')],
    });
    const f = parseLaunchers(blob);
    expect(f.usage).toEqual({ good: { count: 2, lastUsed: 5 } });
    expect(f.custom.map((d) => d.id)).toEqual(['custom:a', 'custom:c']);
  });

  it('custom capped at 50', () => {
    const list = Array.from({ length: 55 }, (_, i) => custom(`custom:c${i}`));
    expect(
      parseLaunchers(JSON.stringify({ version: 1, usage: {}, custom: list })).custom,
    ).toHaveLength(50);
  });

  it('serialize → parse round-trips', () => {
    const f: LaunchersFile = {
      version: 1,
      usage: { 'cli:claude': { count: 3, lastUsed: 99 } },
      custom: [custom('custom:aider', 'aider')],
    };
    expect(parseLaunchers(serializeLaunchers(f))).toEqual(f);
  });
});

describe('bumpUsage', () => {
  it('bumpUsage increments and stamps lastUsed, returns a new object', () => {
    const f = empty();
    const a = bumpUsage(f, 'cli:codex', 10);
    const b = bumpUsage(a, 'cli:codex', 20);
    expect(f.usage).toEqual({});
    expect(a.usage['cli:codex']).toEqual({ count: 1, lastUsed: 10 });
    expect(b.usage['cli:codex']).toEqual({ count: 2, lastUsed: 20 });
    expect(b).not.toBe(a);
  });
});

describe('addCustomLauncher', () => {
  it('add: blank → Enter a command', () => {
    expect(addCustomLauncher(empty(), { commandLine: '   ' }, deps())).toEqual({
      ok: false,
      error: 'Enter a command',
    });
    expect(addCustomLauncher(empty(), { commandLine: 42 }, deps())).toEqual({
      ok: false,
      error: 'Enter a command',
    });
  });

  it('add: 1025 chars → too long', () => {
    expect(
      addCustomLauncher(empty(), { commandLine: `aider ${'x'.repeat(1019)}` }, deps()),
    ).toEqual({
      ok: false,
      error: 'Command is too long (max 1024 characters)',
    });
  });

  it('add: 51st → Custom launcher limit reached (50)', () => {
    const f: LaunchersFile = {
      ...empty(),
      custom: Array.from({ length: 50 }, (_, i) => custom(`custom:c${i}`)),
    };
    expect(addCustomLauncher(f, { commandLine: 'aider' }, deps())).toEqual({
      ok: false,
      error: 'Custom launcher limit reached (50)',
    });
  });

  it('add: unresolvable → Can\'t find "aider" on PATH', () => {
    const r = addCustomLauncher(
      empty(),
      { commandLine: 'aider --x' },
      deps({ resolveCommand: () => undefined }),
    );
    expect(r).toEqual({ ok: false, error: 'Can\'t find "aider" on PATH' });
  });

  it('add: a relative path is refused even when it exists, never persisted cwd-relative (review S2)', () => {
    for (const commandLine of ['.\\tools\\x.cmd --y', 'bin/aider']) {
      const r = addCustomLauncher(empty(), { commandLine }, deps({ resolveCommand: (c) => c }));
      expect(r, commandLine).toEqual({
        ok: false,
        error: `Use an absolute path, not "${commandLine.split(' ')[0]}"`,
      });
    }
  });

  it('add: resolved absolute command, args after argv[0], default label = leaf without .exe', () => {
    const f = empty();
    const r = addCustomLauncher(f, { commandLine: 'aider --model "son net"' }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.def).toEqual({
      id: 'custom:aider',
      label: 'aider',
      command: 'C:\\tools\\aider.exe',
      args: ['--model', 'son net'],
      icon: 'terminal',
      color: 'green',
      cwdStrategy: 'workspaceFolder',
    });
    expect(r.file.custom).toEqual([r.def]);
    expect(f.custom).toEqual([]);
  });

  it('add: a given label is trimmed and cut to 80', () => {
    const r = addCustomLauncher(
      empty(),
      { commandLine: 'aider', label: `  ${'L'.repeat(90)} ` },
      deps(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.def.label).toBe('L'.repeat(80));
    const s = addCustomLauncher(empty(), { commandLine: 'aider', label: 'My Aider!' }, deps());
    if (!s.ok) throw new Error(s.error);
    expect(s.def.id).toBe('custom:my-aider');
  });

  it('add: taken id → custom:aider-2; taken label (case-insensitive) → aider (2)', () => {
    const r = addCustomLauncher(
      empty(),
      { commandLine: 'aider' },
      deps({ takenIds: new Set(['custom:aider']), takenLabels: ['AIDER'] }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.def.id).toBe('custom:aider-2');
    expect(r.def.label).toBe('aider (2)');
  });

  it('add: a label with no slug characters → custom:cmd', () => {
    const r = addCustomLauncher(empty(), { commandLine: 'aider', label: '!!!' }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.def.id).toBe('custom:cmd');
  });
});

describe('removeCustomLauncher', () => {
  it('remove: non-custom id → null', () => {
    const f: LaunchersFile = { ...empty(), custom: [custom('custom:a')] };
    expect(removeCustomLauncher(f, 'shell:pwsh')).toBeNull();
    expect(removeCustomLauncher(f, 7)).toBeNull();
    expect(removeCustomLauncher(f, 'custom:zzz')).toBeNull();
  });

  it('remove: a custom id → a new file without it', () => {
    const f: LaunchersFile = { ...empty(), custom: [custom('custom:a'), custom('custom:b')] };
    expect(removeCustomLauncher(f, 'custom:a')?.custom.map((d) => d.id)).toEqual(['custom:b']);
    expect(f.custom).toHaveLength(2);
  });
});
