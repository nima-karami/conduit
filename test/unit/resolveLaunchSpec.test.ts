import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agentRegistry';
import { resolveLaunchSpec } from '../../src/ptyHost';
import type { AgentDefinition } from '../../src/types';

const claude: AgentDefinition = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  args: ['--dangerously'],
  icon: 'sparkle',
  color: 'terminal.ansiMagenta',
  cwdStrategy: 'workspaceFolder',
};
const reg = new AgentRegistry([claude]);
const exists = () => true;
const missing = () => false;

describe('resolveLaunchSpec', () => {
  it('launches the resolved agent in the requested cwd', () => {
    const s = resolveLaunchSpec(reg, 'claude', '/proj', exists, '/home');
    expect(s.command).toBe('claude');
    expect(s.args).toEqual(['--dangerously']);
    expect(s.cwd).toBe('/proj');
  });

  it('falls back to a shell for the special id "shell"', () => {
    const s = resolveLaunchSpec(reg, 'shell', '/proj', exists, '/home');
    expect(s.command).not.toBe('claude');
    expect(s.args).toEqual([]);
    expect(s.cwd).toBe('/proj');
  });

  it('falls back to a shell for an unknown agent', () => {
    const s = resolveLaunchSpec(reg, 'nope', '/proj', exists, '/home');
    expect(s.command).not.toBe('claude');
    expect(s.cwd).toBe('/proj');
  });

  it('uses fallbackCwd when the requested cwd does not exist', () => {
    const s = resolveLaunchSpec(reg, 'claude', '/ghost', missing, '/home');
    expect(s.cwd).toBe('/home');
    expect(s.command).toBe('claude');
  });

  it('defaults to a shell when no agent id is given', () => {
    const s = resolveLaunchSpec(reg, undefined, '/proj', exists, '/home');
    expect(s.command).not.toBe('claude');
  });
});
