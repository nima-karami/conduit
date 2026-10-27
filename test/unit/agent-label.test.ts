import { describe, expect, it } from 'vitest';
import { agentLabelFor, sessionAgentLabel } from '../../src/agent-label';
import { COMMAND_AGENT_ID } from '../../src/session-command';

describe('agentLabelFor', () => {
  it('registered agent → its label', () => {
    expect(agentLabelFor([{ id: 'shell:cmd', label: 'Command Prompt' }], 'shell:cmd')).toBe(
      'Command Prompt',
    );
  });

  it('unregistered → the id', () => {
    expect(agentLabelFor([], 'cli:claude')).toBe('cli:claude');
  });
});

describe('sessionAgentLabel', () => {
  it('a command session shows its command leaf, not the synthesized id', () => {
    expect(
      sessionAgentLabel([], {
        agentId: COMMAND_AGENT_ID,
        command: { command: '/usr/bin/npm', args: ['test'] },
      }),
    ).toBe('npm');
  });

  it('a registered session keeps its registry label', () => {
    expect(
      sessionAgentLabel([{ id: 'shell:cmd', label: 'Command Prompt' }], { agentId: 'shell:cmd' }),
    ).toBe('Command Prompt');
  });
});
