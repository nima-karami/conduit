import { describe, expect, it } from 'vitest';
import type { RepoDTO } from '../../src/protocol';
import { formatAge, lastSessionTarget, plainShellTarget } from '../../src/start-routes';
import type { AgentDefinition } from '../../src/types';

const agent = (id: string, label: string): AgentDefinition => ({
  id,
  label,
  command: id,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

const AGENTS = [agent('claude', 'Claude Code'), agent('shell:pwsh', 'PowerShell 7')];
const HOME: RepoDTO = { path: 'C:/Users/x', name: 'Home', lastOpened: 0 };
const NOW = 1_000_000_000;

describe('lastSessionTarget', () => {
  it('is null when the only entry is the always-appended Home stub', () => {
    expect(lastSessionTarget([HOME], AGENTS, NOW)).toBeNull();
  });

  it('picks the most recently opened folder and names its remembered agent', () => {
    const repos: RepoDTO[] = [
      { path: 'C:/src/conduit', name: 'conduit', lastAgentId: 'claude', lastOpened: NOW - 60_000 },
      { path: 'C:/src/old', name: 'old', lastAgentId: 'shell:pwsh', lastOpened: NOW - 900_000 },
      HOME,
    ];
    expect(lastSessionTarget(repos, AGENTS, NOW)).toEqual({
      path: 'C:/src/conduit',
      agentId: 'claude',
      repoName: 'conduit',
      agentLabel: 'Claude Code',
      ageMs: 60_000,
    });
  });

  it('drops the agent claim when the remembered agent is no longer installed', () => {
    const repos: RepoDTO[] = [
      { path: 'C:/src/a', name: 'a', lastAgentId: 'aider', lastOpened: NOW - 1000 },
    ];
    const target = lastSessionTarget(repos, AGENTS, NOW);
    expect(target?.agentLabel).toBeUndefined();
    // Empty id = let the host pick; the row still reopens the folder.
    expect(target?.agentId).toBe('');
  });

  it('clamps a future timestamp rather than reporting a negative age', () => {
    const repos: RepoDTO[] = [{ path: 'C:/a', name: 'a', lastOpened: NOW + 5000 }];
    expect(lastSessionTarget(repos, AGENTS, NOW)?.ageMs).toBe(0);
  });
});

describe('plainShellTarget', () => {
  it('never picks an agent, only a shell', () => {
    expect(plainShellTarget([HOME], AGENTS)).toEqual({ path: 'C:/Users/x', agentId: 'shell:pwsh' });
  });

  it('honours the preferred terminal when it is a shell', () => {
    const agents = [...AGENTS, agent('shell:cmd', 'Command Prompt')];
    expect(plainShellTarget([HOME], agents, 'shell:cmd')?.agentId).toBe('shell:cmd');
  });

  it('ignores a preferred terminal that is an agent', () => {
    expect(plainShellTarget([HOME], AGENTS, 'claude')?.agentId).toBe('shell:pwsh');
  });

  it('is null with no shell registered', () => {
    expect(plainShellTarget([HOME], [AGENTS[0]])).toBeNull();
  });

  it('is null with no folder at all', () => {
    expect(plainShellTarget([], AGENTS)).toBeNull();
  });
});

describe('formatAge', () => {
  it('reports one coarse unit', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(59_000)).toBe('just now');
    expect(formatAge(18 * 60_000)).toBe('18m');
    expect(formatAge(90 * 60_000)).toBe('1h');
    expect(formatAge(50 * 3600_000)).toBe('2d');
  });
});
