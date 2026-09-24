import { describe, expect, it } from 'vitest';
import {
  composeLaunchers,
  type LauncherDTO,
  preferredShellId,
  rankLaunchers,
} from '../../src/launchers';
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

  it('Object.prototype names are ordinary ids, not already-taken keys (review N5)', () => {
    const set = composeLaunchers({
      shells: [],
      clis: [],
      config: [def('toString', 'tool'), def('constructor', 'other')],
      custom: [],
    });
    expect(set.defs.map((d) => d.id)).toEqual(['toString', 'constructor']);
    expect(set.kinds).toEqual({ toString: 'config', constructor: 'config' });
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

const dto = (id: string, kind: LauncherDTO['kind'], uses = 0, lastUsed?: number): LauncherDTO =>
  lastUsed === undefined ? { id, kind, uses } : { id, kind, uses, lastUsed };

describe('rankLaunchers', () => {
  const shells = [def('shell:pwsh'), def('shell:cmd')];

  it('no history, claude+codex detected → row [cli:claude, cli:codex], shell pinned', () => {
    const agents = [...shells, def('cli:codex'), def('cli:claude')];
    const launchers = [
      dto('shell:pwsh', 'shell'),
      dto('shell:cmd', 'shell'),
      dto('cli:codex', 'cli'),
      dto('cli:claude', 'cli'),
    ];
    expect(rankLaunchers(agents, launchers, 'shell:pwsh')).toEqual({
      row: ['cli:claude', 'cli:codex'],
      shellId: 'shell:pwsh',
      more: ['shell:cmd'],
    });
  });

  it('3 codex + 1 claude → row [cli:codex, cli:claude]', () => {
    const agents = [...shells, def('cli:claude'), def('cli:codex')];
    const launchers = [
      dto('shell:pwsh', 'shell'),
      dto('shell:cmd', 'shell'),
      dto('cli:claude', 'cli', 1, 50),
      dto('cli:codex', 'cli', 3, 40),
    ];
    expect(rankLaunchers(agents, launchers, 'shell:pwsh').row).toEqual(['cli:codex', 'cli:claude']);
  });

  it('tie on uses → lastUsed desc → canonical order', () => {
    const agents = [
      def('custom:z'),
      def('my-cfg'),
      def('cli:aider'),
      def('cli:claude'),
      def('cli:gemini'),
    ];
    const launchers = [
      dto('custom:z', 'custom', 2),
      dto('my-cfg', 'config', 2),
      dto('cli:aider', 'cli', 2),
      dto('cli:claude', 'cli', 2, 5),
      dto('cli:gemini', 'cli', 2),
    ];
    const r = rankLaunchers(agents, launchers, undefined);
    expect([...r.row, ...r.more]).toEqual([
      'cli:claude',
      'cli:gemini',
      'cli:aider',
      'my-cfg',
      'custom:z',
    ]);
  });

  it('gemini, aider, config entries never push the shell out', () => {
    const agents = [
      def('shell:pwsh'),
      def('cli:claude'),
      def('cli:codex'),
      def('cli:gemini'),
      def('cli:aider'),
      def('cfg'),
    ];
    const launchers = agents.map((a) =>
      dto(a.id, a.id.startsWith('shell') ? 'shell' : a.id === 'cfg' ? 'config' : 'cli', 5),
    );
    const r = rankLaunchers(agents, launchers, 'shell:pwsh');
    expect(r.row).toHaveLength(3);
    expect(r.shellId).toBe('shell:pwsh');
    expect(r.row).not.toContain('shell:pwsh');
    expect(r.more).toEqual(['cli:aider', 'cfg']);
  });

  it('more = remaining non-shells in rank order then other shells', () => {
    const agents = [
      def('shell:a'),
      def('shell:b'),
      def('shell:c'),
      def('cli:claude'),
      def('cli:codex'),
      def('cli:gemini'),
      def('cli:aider'),
      def('cli:opencode'),
    ];
    const launchers = agents.map((a) =>
      dto(a.id, a.id.startsWith('shell') ? 'shell' : 'cli', a.id === 'cli:opencode' ? 9 : 0),
    );
    const r = rankLaunchers(agents, launchers, 'shell:b');
    expect(r.row).toEqual(['cli:opencode', 'cli:claude', 'cli:codex']);
    expect(r.more).toEqual(['cli:gemini', 'cli:aider', 'shell:a', 'shell:c']);
  });

  it('agents without a DTO are not candidates', () => {
    const r = rankLaunchers(
      [def('cli:claude'), def('orphan')],
      [dto('cli:claude', 'cli')],
      undefined,
    );
    expect(r).toEqual({ row: ['cli:claude'], more: [] });
  });
});

describe('preferredShellId', () => {
  const launchers = [
    dto('cli:claude', 'cli'),
    dto('shell:pwsh', 'shell'),
    dto('shell:cmd', 'shell'),
  ];
  it('defaultAgentId shell → it; non-shell default → first shell; none → undefined', () => {
    expect(preferredShellId(launchers, 'shell:cmd')).toBe('shell:cmd');
    expect(preferredShellId(launchers, 'cli:claude')).toBe('shell:pwsh');
    expect(preferredShellId(launchers, '')).toBe('shell:pwsh');
    expect(preferredShellId([dto('cli:claude', 'cli')], 'cli:claude')).toBeUndefined();
  });
});
