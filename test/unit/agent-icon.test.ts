import { describe, expect, it } from 'vitest';
import { agentIconKindFromText, resolveAgentIcon } from '../../src/agent-icon';
import { COMMAND_AGENT_ID } from '../../src/session-command';
import type { AgentDefinition, Session } from '../../src/types';

const def = (id: string, command: string, args: string[] = []): AgentDefinition => ({
  id,
  label: id,
  command,
  args,
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});
const S = (over: Partial<Session> = {}): Session => ({
  id: 's',
  name: 's',
  agentId: 'shell',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});
const agents = [def('shell', 'bash'), def('cc', 'claude'), def('cx', 'codex'), def('pw', 'pwsh')];

describe('agentIconKindFromText', () => {
  it('detects every built-in agent kind by whole token', () => {
    expect(agentIconKindFromText('claude')).toBe('claude');
    expect(agentIconKindFromText('npx', 'codex')).toBe('codex');
    expect(agentIconKindFromText('/usr/bin/opencode')).toBe('opencode');
    expect(agentIconKindFromText('cursor-agent')).toBe('cursor');
    expect(agentIconKindFromText('Gemini.EXE')).toBe('gemini');
    expect(agentIconKindFromText('pwsh')).toBe('powershell');
    expect(agentIconKindFromText('Windows PowerShell')).toBe('powershell');
  });

  it('keeps the generic AI mark for agents without their own, and null for the rest', () => {
    expect(agentIconKindFromText('aider')).toBe('claude');
    expect(agentIconKindFromText('bash')).toBeNull();
    expect(agentIconKindFromText('')).toBeNull();
    expect(agentIconKindFromText('encoder')).toBeNull();
  });

  it('an agent outranks the shell it runs in', () => {
    expect(agentIconKindFromText('pwsh', 'codex')).toBe('codex');
  });
});

describe('resolveAgentIcon precedence', () => {
  it('user override first', () => {
    const session = S({ iconOverride: 'rocket', appIcon: 'codex' });
    expect(resolveAgentIcon({ session, agents, boundCli: 'claude' })).toEqual({
      type: 'lucide',
      name: 'rocket',
    });
  });

  it('then the MCP CLI binding, then the handle prefix', () => {
    const session = S({ appIcon: 'claude', agentId: 'cx' });
    expect(resolveAgentIcon({ session, agents, boundCli: 'gemini', handle: 'codex-2' })).toEqual({
      type: 'kind',
      kind: 'gemini',
    });
    expect(resolveAgentIcon({ session, agents, handle: 'opencode-2' })).toEqual({
      type: 'kind',
      kind: 'opencode',
    });
  });

  it('then the detected title app, then the configured command', () => {
    expect(resolveAgentIcon({ session: S({ appIcon: 'cursor', agentId: 'cx' }), agents })).toEqual({
      type: 'kind',
      kind: 'cursor',
    });
    expect(resolveAgentIcon({ session: S({ agentId: 'cx' }), agents })).toEqual({
      type: 'kind',
      kind: 'codex',
    });
    expect(resolveAgentIcon({ session: S({ agentId: 'pw' }), agents })).toEqual({
      type: 'kind',
      kind: 'powershell',
    });
  });

  it('reads a custom command session through its own command', () => {
    const session = S({ agentId: COMMAND_AGENT_ID, command: { command: 'gemini', args: [] } });
    expect(resolveAgentIcon({ session, agents })).toEqual({ type: 'kind', kind: 'gemini' });
  });

  it('falls back to terminal, ignoring flag args and unknown bindings', () => {
    expect(resolveAgentIcon({ session: S(), agents })).toEqual({ type: 'kind', kind: 'terminal' });
    expect(resolveAgentIcon({ session: S({ agentId: 'gone' }), agents, handle: 'x-1' })).toEqual({
      type: 'kind',
      kind: 'terminal',
    });
    const flagged = [def('b', 'bash', ['--cursor-shape=block'])];
    expect(resolveAgentIcon({ session: S({ agentId: 'b' }), agents: flagged })).toEqual({
      type: 'kind',
      kind: 'terminal',
    });
  });
});
