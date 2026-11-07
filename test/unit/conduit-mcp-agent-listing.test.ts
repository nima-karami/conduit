import { describe, expect, it } from 'vitest';
import { agentListing } from '../../src/conduit-mcp/agent-listing';
import type { AgentDefinition } from '../../src/types';

const def = (
  over: Pick<AgentDefinition, 'id' | 'command'> & Partial<AgentDefinition>,
): AgentDefinition => ({
  label: over.id,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
  ...over,
});
const ON = { messagingOn: true, e2e: false };

describe('agentListing (list_agents rows, flexible-agent-contracts §4.2)', () => {
  it('a built-in CLI is wired, with notices, brief and model', () => {
    expect(agentListing(def({ id: 'cli:claude', command: 'claude' }), 'detected', ON)).toEqual({
      id: 'cli:claude',
      label: 'cli:claude',
      command: 'claude',
      source: 'detected',
      model: true,
      messaging: 'wired',
      notices: true,
      brief: true,
    });
  });

  it('a profile with no adapter is env, with model only when it has a model_flag', () => {
    const plain = agentListing(def({ id: 'kiro', command: 'kiro' }), 'profile', ON);
    expect(plain).toMatchObject({ messaging: 'env', notices: false, brief: false, model: false });
    const withFlag = agentListing(
      def({ id: 'kiro', command: 'kiro', capabilities: { model_flag: '--m' } }),
      'profile',
      ON,
    );
    expect(withFlag.model).toBe(true);
  });

  it('a shell is none whatever messaging is', () => {
    expect(agentListing(def({ id: 'shell:pwsh', command: 'pwsh' }), 'shell', ON).messaging).toBe(
      'none',
    );
  });

  it('with messaging off every agent is none', () => {
    const off = { messagingOn: false, e2e: false };
    expect(
      agentListing(def({ id: 'cli:claude', command: 'claude' }), 'detected', off).messaging,
    ).toBe('none');
    expect(agentListing(def({ id: 'kiro', command: 'kiro' }), 'profile', off).messaging).toBe(
      'none',
    );
  });
});
