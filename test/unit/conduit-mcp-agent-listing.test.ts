import { describe, expect, it } from 'vitest';
import { agentListing, listAgentsOutput } from '../../src/conduit-mcp/agent-listing';
import { MESSAGING_TOOL_NAMES, TOOL_GROUPS, TOOL_SPECS } from '../../src/conduit-mcp/tool-policy';
import type { AgentListing } from '../../src/conduit-mcp/tools';
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

const row = (id: string, source: AgentListing['source'], label = id): AgentListing => ({
  id,
  label,
  command: id,
  source,
  model: false,
  messaging: 'env',
  notices: false,
  brief: false,
});

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

  it('with the master switch off every agent is none', () => {
    const off = { messagingOn: false, e2e: false };
    expect(
      agentListing(def({ id: 'cli:claude', command: 'claude' }), 'detected', off).messaging,
    ).toBe('none');
    expect(agentListing(def({ id: 'kiro', command: 'kiro' }), 'profile', off).messaging).toBe(
      'none',
    );
  });
});

describe('listAgentsOutput order (flexible-agent-contracts §4.2)', () => {
  it('orders profile, launcher, detected, shell, then label, whatever the input order', () => {
    const out = listAgentsOutput([
      row('shell:pwsh', 'shell', 'PowerShell'),
      row('cli:codex', 'detected', 'Codex'),
      row('zeta', 'profile', 'Zeta'),
      row('mine', 'launcher', 'Mine'),
      row('alpha', 'profile', 'Alpha'),
    ]);
    expect(out.agents.map((a) => a.id)).toEqual([
      'alpha',
      'zeta',
      'mine',
      'cli:codex',
      'shell:pwsh',
    ]);
    expect(out.bare_commands).toBe(true);
  });

  it('an empty catalog is an empty list, not an error', () => {
    expect(listAgentsOutput([])).toEqual({ agents: [], bare_commands: true });
  });
});

describe('list_agents policy (flexible-agent-contracts §4.2, review 4)', () => {
  it('sits in the sessions group, not messaging, budgeted to show, access on', () => {
    const sessions = TOOL_GROUPS.find((g) => g.group === 'sessions')?.tools ?? [];
    expect(sessions).toContain('list_agents');
    expect(MESSAGING_TOOL_NAMES).not.toContain('list_agents');
    expect(TOOL_SPECS.list_agents).toMatchObject({ budget: 'show', defaults: { access: 'on' } });
  });
});
