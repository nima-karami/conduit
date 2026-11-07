import { describe, expect, it } from 'vitest';
import { resolveAgentArg } from '../../src/conduit-mcp/agent-resolve';

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
