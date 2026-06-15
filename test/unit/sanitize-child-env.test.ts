import { describe, expect, it } from 'vitest';
import { sanitizeChildEnv } from '../../src/pty-host';

describe('sanitizeChildEnv', () => {
  it('removes TERM_PROGRAM', () => {
    const result = sanitizeChildEnv({ TERM_PROGRAM: 'vscode', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('TERM_PROGRAM');
    expect(result.PATH).toBe('/usr/bin');
  });

  it('removes TERM_PROGRAM_VERSION', () => {
    const result = sanitizeChildEnv({ TERM_PROGRAM_VERSION: '1.80.0', HOME: '/home/user' });
    expect(result).not.toHaveProperty('TERM_PROGRAM_VERSION');
    expect(result.HOME).toBe('/home/user');
  });

  it('removes all VSCODE_* keys', () => {
    const env = {
      VSCODE_PID: '1234',
      VSCODE_GIT_IPC_HANDLE: '/tmp/git.sock',
      VSCODE_GIT_ASKPASS_MAIN: '/usr/share/code/askpass.js',
      VSCODE_GIT_ASKPASS_NODE: '/usr/share/code/node',
      VSCODE_INJECTION: '1',
      HOME: '/home/user',
    };
    const result = sanitizeChildEnv(env);
    expect(result).not.toHaveProperty('VSCODE_PID');
    expect(result).not.toHaveProperty('VSCODE_GIT_IPC_HANDLE');
    expect(result).not.toHaveProperty('VSCODE_GIT_ASKPASS_MAIN');
    expect(result).not.toHaveProperty('VSCODE_GIT_ASKPASS_NODE');
    expect(result).not.toHaveProperty('VSCODE_INJECTION');
    expect(result.HOME).toBe('/home/user');
  });

  it('removes all CURSOR_* keys', () => {
    const env = {
      CURSOR_TRACE_ID: 'abc123',
      CURSOR_CHANNEL: 'stable',
      PATH: '/usr/local/bin:/usr/bin',
    };
    const result = sanitizeChildEnv(env);
    expect(result).not.toHaveProperty('CURSOR_TRACE_ID');
    expect(result).not.toHaveProperty('CURSOR_CHANNEL');
    expect(result.PATH).toBe('/usr/local/bin:/usr/bin');
  });

  it('preserves PATH, HOME, and other unrelated vars', () => {
    const env = {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/user',
      SHELL: '/bin/zsh',
      USER: 'alice',
      LANG: 'en_US.UTF-8',
      TERM_PROGRAM: 'vscode',
    };
    const result = sanitizeChildEnv(env);
    expect(result.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.SHELL).toBe('/bin/zsh');
    expect(result.USER).toBe('alice');
    expect(result.LANG).toBe('en_US.UTF-8');
  });

  it('strips GIT_ASKPASS when editor vars are present', () => {
    const env = {
      GIT_ASKPASS: '/usr/share/code/askpass.sh',
      VSCODE_PID: '5678',
      PATH: '/usr/bin',
    };
    const result = sanitizeChildEnv(env);
    expect(result).not.toHaveProperty('GIT_ASKPASS');
  });

  it('preserves GIT_ASKPASS when no editor vars are present', () => {
    const env = {
      GIT_ASKPASS: '/home/user/bin/my-askpass.sh',
      PATH: '/usr/bin',
      HOME: '/home/user',
    };
    const result = sanitizeChildEnv(env);
    expect(result.GIT_ASKPASS).toBe('/home/user/bin/my-askpass.sh');
  });

  it('spec.env overrides sanitized env (caller wins)', () => {
    // This simulates the spawn site: { ...sanitizeChildEnv(process.env), ...spec.env }
    const parent: NodeJS.ProcessEnv = { TERM_PROGRAM: 'vscode', PATH: '/usr/bin' };
    const specEnv: NodeJS.ProcessEnv = { TERM_PROGRAM: 'my-override', MY_VAR: 'hello' };
    const result: NodeJS.ProcessEnv = { ...sanitizeChildEnv(parent), ...specEnv };
    // spec.env can set TERM_PROGRAM if it wants to
    expect(result.TERM_PROGRAM).toBe('my-override');
    expect(result.MY_VAR).toBe('hello');
    // non-stripped vars from parent survive
    expect(result.PATH).toBe('/usr/bin');
  });

  it('is idempotent on an already-clean env', () => {
    const clean = {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/user',
      SHELL: '/bin/bash',
    };
    const result = sanitizeChildEnv(clean);
    expect(result).toEqual(clean);
  });

  it('handles an empty env without throwing', () => {
    expect(() => sanitizeChildEnv({})).not.toThrow();
    expect(sanitizeChildEnv({})).toEqual({});
  });
});
