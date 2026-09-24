import { describe, expect, it } from 'vitest';
import { agentLabelFor } from '../../src/agent-label';

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
