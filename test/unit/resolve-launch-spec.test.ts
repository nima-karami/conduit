import { describe, expect, it } from 'vitest';
import { resolveLaunchSpec } from '../../src/pty-host';
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
const exists = () => true;
const missing = () => false;

describe('resolveLaunchSpec', () => {
  it('launches the resolved agent in the requested cwd', () => {
    const s = resolveLaunchSpec(claude, '/proj', exists, '/home');
    expect(s.command).toBe('claude');
    expect(s.args).toEqual(['--dangerously']);
    expect(s.cwd).toBe('/proj');
  });

  it('launches a shell when there is no definition', () => {
    const s = resolveLaunchSpec(undefined, '/proj', exists, '/home');
    expect(s.command).not.toBe('claude');
    expect(s.args).toEqual(process.platform === 'win32' ? [] : ['-i', '-l']);
    expect(s.cwd).toBe('/proj');
  });

  it('uses fallbackCwd when the requested cwd does not exist', () => {
    const s = resolveLaunchSpec(claude, '/ghost', missing, '/home');
    expect(s.cwd).toBe('/home');
    expect(s.command).toBe('claude');
  });

  it.skipIf(process.platform === 'win32')(
    'omits -i -l for a $SHELL that rejects them (dash/ash/sh, e.g. Alpine)',
    () => {
      const prevShell = process.env.SHELL;
      try {
        for (const shell of ['/bin/dash', '/usr/bin/ash', '/bin/sh']) {
          process.env.SHELL = shell;
          const s = resolveLaunchSpec(undefined, '/proj', exists, '/home');
          expect(s.command).toBe(shell);
          expect(s.args).toEqual([]);
        }
      } finally {
        process.env.SHELL = prevShell;
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still uses -i -l for a login-capable $SHELL (zsh/bash/fish)',
    () => {
      const prevShell = process.env.SHELL;
      try {
        process.env.SHELL = '/bin/zsh';
        const s = resolveLaunchSpec(undefined, '/proj', exists, '/home');
        expect(s.args).toEqual(['-i', '-l']);
      } finally {
        process.env.SHELL = prevShell;
      }
    },
  );
});
