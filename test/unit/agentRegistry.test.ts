import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agentRegistry';
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
});
