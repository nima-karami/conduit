import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import {
  COMMAND_AGENT_ID,
  coerceOpenedBy,
  coerceSessionCommand,
  commandDef,
  commandLabel,
  effectiveDef,
  MAX_ARGS,
  MAX_ARGS_BYTES,
  MAX_COMMAND_BYTES,
} from '../../src/session-command';
import type { AgentDefinition } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  args: [],
  icon: 'sparkle',
  color: 'terminal.ansiMagenta',
  cwdStrategy: 'workspaceFolder',
};
const defs: Record<string, AgentDefinition> = { claude };
const registry = { get: (id: string) => defs[id] };

describe('session-command', () => {
  it('the command id is in the reserved namespace the registry refuses', () => {
    expect(COMMAND_AGENT_ID).toBe('conduit:command');
    expect(AgentRegistry.isValid(commandDef({ command: 'node', args: [] }))).toBe(false);
  });

  it('effectiveDef of a registered session is registry.get', () => {
    expect(effectiveDef({ agentId: 'claude' }, registry)).toBe(claude);
    expect(effectiveDef({ agentId: 'nope' }, registry)).toBeUndefined();
  });

  it('effectiveDef of a command session is commandDef, never registry', () => {
    const reg = { get: (id: string) => (id === COMMAND_AGENT_ID ? claude : undefined) };
    const d = effectiveDef(
      {
        agentId: COMMAND_AGENT_ID,
        command: { command: '/usr/bin/cursor-agent', args: ['-p', 'x'] },
      },
      reg,
    );
    expect(d).toEqual({
      id: COMMAND_AGENT_ID,
      label: 'cursor-agent',
      command: '/usr/bin/cursor-agent',
      args: ['-p', 'x'],
      icon: 'terminal',
      color: 'green',
      cwdStrategy: 'workspaceFolder',
    });
  });

  it('effectiveDef of a command session without command is undefined', () => {
    expect(effectiveDef({ agentId: COMMAND_AGENT_ID }, { get: () => claude })).toBeUndefined();
  });

  it('commandDef args are a copy', () => {
    const c = { command: 'node', args: ['a'] };
    const d = commandDef(c);
    d.args.push('b');
    expect(c.args).toEqual(['a']);
  });

  it('commandLabel is the command leaf', () => {
    expect(commandLabel({ command: '/usr/bin/cursor-agent', args: [] })).toBe('cursor-agent');
    expect(commandLabel({ command: 'node', args: [] })).toBe('node');
  });

  it('coerceSessionCommand', () => {
    expect(coerceSessionCommand({ command: 'node', args: ['-e', 'x'] })).toEqual({
      command: 'node',
      args: ['-e', 'x'],
    });
    expect(coerceSessionCommand({ command: '', args: [] })).toBeUndefined();
    expect(
      coerceSessionCommand({ command: 'a'.repeat(MAX_COMMAND_BYTES), args: [] }),
    ).toBeDefined();
    expect(
      coerceSessionCommand({ command: 'a'.repeat(MAX_COMMAND_BYTES + 1), args: [] }),
    ).toBeUndefined();
    // Bytes, not chars: 512 two-byte chars is 1024 bytes, 513 is over.
    expect(coerceSessionCommand({ command: 'é'.repeat(512), args: [] })).toBeDefined();
    expect(coerceSessionCommand({ command: 'é'.repeat(513), args: [] })).toBeUndefined();
    expect(coerceSessionCommand({ command: 'n', args: Array(MAX_ARGS).fill('a') })).toBeDefined();
    expect(
      coerceSessionCommand({ command: 'n', args: Array(MAX_ARGS + 1).fill('a') }),
    ).toBeUndefined();
    expect(
      coerceSessionCommand({ command: 'n', args: ['a'.repeat(MAX_ARGS_BYTES)] }),
    ).toBeDefined();
    expect(
      coerceSessionCommand({
        command: 'n',
        args: ['a'.repeat(MAX_ARGS_BYTES / 2), 'a'.repeat(MAX_ARGS_BYTES / 2 + 1)],
      }),
    ).toBeUndefined();
    expect(coerceSessionCommand({ command: 'n', args: ['a', 1] })).toBeUndefined();
    expect(coerceSessionCommand({ command: 'n' })).toBeUndefined();
    expect(coerceSessionCommand({ command: 3, args: [] })).toBeUndefined();
    expect(coerceSessionCommand(null)).toBeUndefined();
    expect(coerceSessionCommand('node')).toBeUndefined();
  });

  it('coerceSessionCommand returns a fresh copy without extra keys', () => {
    const src = { command: 'n', args: ['a'], extra: 1 };
    const out = coerceSessionCommand(src);
    expect(out).toEqual({ command: 'n', args: ['a'] });
    out?.args.push('b');
    expect(src.args).toEqual(['a']);
  });

  it('coerceOpenedBy requires both strings', () => {
    expect(coerceOpenedBy({ handle: 'claude-1', sessionId: 's1' })).toEqual({
      handle: 'claude-1',
      sessionId: 's1',
    });
    expect(coerceOpenedBy({ handle: 'claude-1' })).toBeUndefined();
    expect(coerceOpenedBy({ handle: 1, sessionId: 's1' })).toBeUndefined();
    expect(coerceOpenedBy(null)).toBeUndefined();
    expect(coerceOpenedBy([])).toBeUndefined();
  });
});
