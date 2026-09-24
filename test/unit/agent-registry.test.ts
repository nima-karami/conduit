import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import type { AgentDefinition } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  args: ['--foo'],
  icon: 'sparkle',
  color: 'terminal.ansiMagenta',
  cwdStrategy: 'workspaceFolder',
};

describe('AgentRegistry', () => {
  it('lists validated agents', () => {
    const r = new AgentRegistry([claude]);
    expect(r.list().map((a) => a.id)).toEqual(['claude']);
  });

  it('drops invalid agents (missing command)', () => {
    const bad = { ...claude, id: 'bad', command: '' } as AgentDefinition;
    const r = new AgentRegistry([claude, bad]);
    expect(r.list().map((a) => a.id)).toEqual(['claude']);
  });

  it('resolves an agent + target into a SpawnSpec', () => {
    const r = new AgentRegistry([claude]);
    const spec = r.resolve('claude', '/work/proj');
    expect(spec).toEqual({ command: 'claude', args: ['--foo'], cwd: '/work/proj' });
  });

  it('throws when agent id is unknown', () => {
    const r = new AgentRegistry([claude]);
    expect(() => r.resolve('nope', '/work/proj')).toThrow(/unknown agent/i);
  });

  it('get follows an alias; list never includes it', () => {
    const r = new AgentRegistry([claude], { 'cli:claude': 'claude' });
    expect(r.get('cli:claude')?.id).toBe('claude');
    expect(r.list().map((a) => a.id)).toEqual(['claude']);
    expect(r.get('cli:codex')).toBeUndefined();
  });

  it('resolve through an alias', () => {
    const mine = { ...claude, id: 'my-claude', command: 'C:/x/claude.exe' };
    const r = new AgentRegistry([mine], { 'cli:claude': 'my-claude' });
    expect(r.resolve('cli:claude', '/w')).toEqual({
      command: 'C:/x/claude.exe',
      args: ['--foo'],
      cwd: '/w',
    });
  });

  it('replace mutates in place — a held reference sees new defs', () => {
    const r = new AgentRegistry([claude]);
    const held = r;
    held.replace([{ ...claude, id: 'codex', command: 'codex' }], {});
    expect(r.list().map((a) => a.id)).toEqual(['codex']);
    expect(r.get('claude')).toBeUndefined();
  });

  it('replace returns false for an equal set, true for a changed arg/label/order/alias', () => {
    const codex = { ...claude, id: 'codex', command: 'codex' };
    const r = new AgentRegistry([claude, codex], { 'cli:claude': 'claude' });
    expect(r.replace([{ ...claude }, { ...codex }], { 'cli:claude': 'claude' })).toBe(false);
    expect(r.replace([{ ...claude, args: ['--bar'] }, codex], { 'cli:claude': 'claude' })).toBe(
      true,
    );
    expect(
      r.replace([{ ...claude, args: ['--bar'], label: 'L' }, codex], { 'cli:claude': 'claude' }),
    ).toBe(true);
    expect(
      r.replace([codex, { ...claude, args: ['--bar'], label: 'L' }], { 'cli:claude': 'claude' }),
    ).toBe(true);
    expect(r.replace([codex, { ...claude, args: ['--bar'], label: 'L' }], {})).toBe(true);
    expect(r.replace([codex, { ...claude, args: ['--bar'], label: 'L' }], {})).toBe(false);
  });

  it('replace drops invalid defs', () => {
    const r = new AgentRegistry([]);
    r.replace([claude, { ...claude, id: 'bad', command: '' }], {});
    expect(r.list().map((a) => a.id)).toEqual(['claude']);
  });
});
