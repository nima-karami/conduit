import { describe, expect, it } from 'vitest';
import { composeLaunchers } from '../../src/launchers';
import type { AgentDefinition } from '../../src/types';

const def = (id: string, command = id, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id,
  label: id,
  command,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
  ...extra,
});

describe('composeLaunchers', () => {
  it('order shells, clis, config, custom; kinds keyed by id', () => {
    const set = composeLaunchers({
      shells: [def('shell:pwsh', 'pwsh.exe')],
      clis: [def('cli:codex', 'C:\\bin\\codex.exe')],
      config: [def('my-agent', 'my-tool')],
      custom: [def('custom:x', '/bin/x')],
    });
    expect(set.defs.map((d) => d.id)).toEqual(['shell:pwsh', 'cli:codex', 'my-agent', 'custom:x']);
    expect(set.kinds).toEqual({
      'shell:pwsh': 'shell',
      'cli:codex': 'cli',
      'my-agent': 'config',
      'custom:x': 'custom',
    });
    expect(set.aliases).toEqual({});
  });

  it('duplicate id: first wins', () => {
    const set = composeLaunchers({
      shells: [def('a', 'sh-a')],
      clis: [],
      config: [def('a', 'cfg-a'), def('b')],
      custom: [],
    });
    expect(set.defs.map((d) => [d.id, d.command])).toEqual([
      ['a', 'sh-a'],
      ['b', 'b'],
    ]);
    expect(set.kinds.a).toBe('shell');
  });

  it('agents.json {id:my-claude, command:claude} hides cli:claude and aliases it', () => {
    const set = composeLaunchers({
      shells: [],
      clis: [def('cli:claude', 'C:\\u\\.local\\bin\\claude.exe'), def('cli:codex', 'codex')],
      config: [def('my-claude', 'claude')],
      custom: [],
    });
    expect(set.defs.map((d) => d.id)).toEqual(['cli:codex', 'my-claude']);
    expect(set.aliases).toEqual({ 'cli:claude': 'my-claude' });
    expect(set.kinds['cli:claude']).toBeUndefined();
  });

  it('config C:\\x\\claude.cmd shadows too; codex config does not shadow claude', () => {
    const set = composeLaunchers({
      shells: [],
      clis: [def('cli:claude', 'claude.exe'), def('cli:codex', 'codex.exe')],
      config: [def('cfg-claude', 'C:\\x\\claude.cmd'), def('cfg-other', 'codexx')],
      custom: [],
    });
    expect(set.defs.map((d) => d.id)).toEqual(['cli:codex', 'cfg-claude', 'cfg-other']);
    expect(set.aliases).toEqual({ 'cli:claude': 'cfg-claude' });
  });

  it('invalid defs dropped', () => {
    const set = composeLaunchers({
      shells: [def('', 'x')],
      clis: [def('cli:codex', '')],
      config: [def('ok', 'ok')],
      custom: [],
    });
    expect(set.defs.map((d) => d.id)).toEqual(['ok']);
  });
});
