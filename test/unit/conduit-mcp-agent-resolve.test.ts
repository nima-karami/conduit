import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import {
  isRefusedLeaf,
  registeredIdFor,
  resolveAgentArg,
} from '../../src/conduit-mcp/agent-resolve';

const registeredIds = ['claude', 'cli:codex', 'shell:pwsh'];
const onPath: Record<string, string> = {
  kiro: '/usr/local/bin/kiro',
  'kiro.cmd': '/usr/local/bin/kiro.cmd',
  codex: '/usr/bin/codex',
  powershell: '/usr/bin/powershell',
};
const deps = {
  registeredIds,
  resolveCommand: (c: string) => onPath[c],
};

describe('resolveAgentArg', () => {
  it('a bare name that is an alias of a registered definition runs that definition, not PATH', () => {
    const r = resolveAgentArg('claude', {
      registeredIds: ['my-claude'],
      resolveRegistered: (n) => (n === 'claude' ? 'my-claude' : undefined),
      resolveCommand: () => '/usr/bin/claude',
    });
    expect(r).toEqual({ ok: true, value: { kind: 'registered', id: 'my-claude' } });
  });

  it('a registered id wins over a PATH command of the same name', () => {
    const r = resolveAgentArg('shell:pwsh', {
      registeredIds: ['shell:pwsh'],
      resolveCommand: () => '/bin/pwsh',
    });
    expect(r).toEqual({ ok: true, value: { kind: 'registered', id: 'shell:pwsh' } });
  });

  it('a bare command on PATH resolves to its absolute path and leaf', () => {
    expect(resolveAgentArg('kiro', deps)).toEqual({
      ok: true,
      value: { kind: 'command', path: '/usr/local/bin/kiro', leaf: 'kiro' },
    });
  });

  it('a shim with an extension resolves, and the leaf drops the extension', () => {
    expect(resolveAgentArg('kiro.cmd', deps)).toEqual({
      ok: true,
      value: { kind: 'command', path: '/usr/local/bin/kiro.cmd', leaf: 'kiro' },
    });
  });

  it.each(['powershell', 'PowerShell.exe', 'node', 'git', 'cmd.exe', 'bash', 'npx'])(
    'the refused leaf %s → invalid_args with a hint to use open_terminal',
    (agent) => {
      const r = resolveAgentArg(agent, {
        registeredIds,
        resolveCommand: () => `/bin/${agent}`,
      });
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'invalid_args', hint: expect.stringContaining('open_terminal') },
      });
    },
  );

  it.each(['C:\\x\\kiro', '/usr/bin/kiro', 'bin\\kiro'])(
    'a path %s → invalid_args, never looked up on PATH',
    (agent) => {
      let looked = false;
      const r = resolveAgentArg(agent, {
        registeredIds,
        resolveCommand: () => {
          looked = true;
          return '/x';
        },
      });
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
      expect(looked).toBe(false);
    },
  );

  it('a name that is not on PATH → unknown_agent with a hint and the registered ids', () => {
    const r = resolveAgentArg('nope', deps);
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: 'unknown_agent',
        hint: expect.stringContaining('list_agents'),
        valid: registeredIds,
      },
    });
  });

  it('a name outside the bare-command shape is unknown_agent, not a PATH lookup', () => {
    let looked = false;
    const r = resolveAgentArg('my agent', {
      registeredIds,
      resolveCommand: () => {
        looked = true;
        return '/x';
      },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'unknown_agent' } });
    expect(looked).toBe(false);
  });

  it('a leading dash is never a command name', () => {
    expect(resolveAgentArg('-kiro', deps)).toMatchObject({
      ok: false,
      error: { code: 'unknown_agent' },
    });
  });
});

describe('refused leaves are normalized (flexible-agent-contracts §3.1)', () => {
  it.each([
    'powershell.cmd',
    'NODE.BAT',
    'bash.com',
    'python3.12',
    'python3',
    'pythonw',
    'pwsh-preview7.4',
    'java.exe',
    'env',
    'docker.exe',
  ])('%s is refused', (name) => {
    expect(isRefusedLeaf(name)).toBe(true);
    expect(resolveAgentArg(name, { registeredIds: [], resolveCommand: () => '/x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_args' },
    });
  });

  it('an agent-shaped name is not refused by its look', () => {
    expect(isRefusedLeaf('kiro.cmd')).toBe(false);
    expect(isRefusedLeaf('codex')).toBe(false);
  });
});

describe('registeredIdFor through the real registry (flexible-agent-contracts §3.1)', () => {
  it('a name reaches its cli: alias, which a shadowing profile holds', () => {
    const registry = new AgentRegistry(
      [
        {
          id: 'my-claude',
          label: 'My Claude',
          command: 'claude',
          args: [],
          icon: 'terminal',
          color: 'green',
          cwdStrategy: 'workspaceFolder',
        },
      ],
      { 'cli:claude': 'my-claude' },
    );
    const lookup = (id: string) => registry.get(id)?.id;
    expect(registeredIdFor('claude', lookup)).toBe('my-claude');
    expect(registeredIdFor('CLAUDE.exe', lookup)).toBe('my-claude');
    expect(registeredIdFor('claude2', lookup)).toBeUndefined();
    expect(registeredIdFor('my-claude', lookup)).toBe('my-claude');
  });
});
