import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agent-registry';
import { adapterFor, modelArgsFor, modelFlagOf } from '../../src/conduit-mcp/adapters';
import { commandDef, effectiveDef } from '../../src/session-command';
import type { AgentDefinition } from '../../src/types';

const base = { icon: 'terminal', color: 'green', cwdStrategy: 'workspaceFolder' } as const;
const profile = (over: Partial<AgentDefinition> & { id: string; command: string }) =>
  ({ label: over.id, args: [], ...base, ...over }) as AgentDefinition;

describe('modelFlagOf (built-in adapter mapping wins over capabilities.model_flag)', () => {
  it('the built-in adapters keep their flags', () => {
    expect(modelFlagOf(profile({ id: 'c', command: 'claude' }))).toBe('--model');
    expect(modelFlagOf(profile({ id: 'x', command: '/usr/bin/codex' }))).toBe('-m');
  });

  it('a profile with model_flag takes that flag when no adapter applies', () => {
    const def = profile({
      id: 'kiro',
      command: 'kiro',
      capabilities: { model_flag: '--model-name' },
    });
    expect(modelFlagOf(def)).toBe('--model-name');
    expect(modelArgsFor(def, 'k2')).toEqual(['--model-name', 'k2']);
  });

  it('the adapter mapping beats a profile model_flag', () => {
    const def = profile({
      id: 'c',
      command: 'claude',
      capabilities: { model_flag: '--other' },
    });
    expect(modelArgsFor(def, 'opus')).toEqual(['--model', 'opus']);
  });

  it('no adapter and no model_flag → no model argv', () => {
    expect(modelFlagOf(profile({ id: 'sh', command: 'sh' }))).toBeUndefined();
    expect(modelArgsFor(profile({ id: 'sh', command: 'sh' }), 'x')).toBeNull();
  });
});

describe('bare commands get the built-in adapter (§3.1)', () => {
  it('a resolved codex path gets the codex adapter, wiring and model', () => {
    expect(adapterFor({ id: 'x', command: 'C:\\npm\\codex.cmd' }, { e2e: false })?.id).toBe(
      'codex',
    );
    expect(modelArgsFor(commandDef({ command: '/usr/bin/codex', args: [] }), 'gpt')).toEqual([
      '-m',
      'gpt',
    ]);
  });
});

describe('effectiveDef applies the model to command sessions and profiles (§4.4)', () => {
  const registry = new AgentRegistry([
    profile({ id: 'kiro', command: 'kiro', args: ['--fast'], capabilities: { model_flag: '--m' } }),
  ]);

  it('a profile model_flag appends [flag, model] after the profile args', () => {
    const def = effectiveDef({ agentId: 'kiro', model: 'k2' }, registry);
    expect(def?.args).toEqual(['--fast', '--m', 'k2']);
  });

  it('a command session with a model gets the adapter flag', () => {
    const def = effectiveDef(
      { agentId: 'conduit:command', command: { command: '/usr/bin/codex', args: [] }, model: 'g' },
      registry,
    );
    expect(def?.args).toEqual(['-m', 'g']);
  });

  it('a command session without an adapter ignores the model', () => {
    const def = effectiveDef(
      { agentId: 'conduit:command', command: { command: '/usr/bin/kiro', args: [] }, model: 'g' },
      registry,
    );
    expect(def?.args).toEqual([]);
  });
});
