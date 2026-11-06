import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error standalone node tool, no declarations
import { checkMacCore, smokeMacHc } from '../../tools/smoke-mac-hc.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('Mac hc smoke safety', () => {
  it('refuses a developer profile before accessing runtime or platform-specific files', () => {
    vi.stubEnv('CI', '');
    expect(() => smokeMacHc()).toThrow(/refusing.*outside CI/i);
  });

  it('preserves failed-start stderr when stopping also fails', () => {
    const original = Object.assign(new Error('start failed'), {
      stderr: 'original socket failure',
    });
    const cleanup = new Error('stop failed');
    const errors: unknown[] = [];
    let caught: unknown;
    try {
      checkMacCore({
        socket: '/private/core.sock',
        run: (args: string[]) => {
          throw args[1] === 'start' ? original : cleanup;
        },
        error: (...args: unknown[]) => errors.push(...args),
      });
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(original);
    expect(caught).toMatchObject({ stderr: 'original socket failure' });
    expect(errors).toContain(cleanup);
  });

  it('fails and stops the core if start did not create the selected socket', () => {
    const calls: string[][] = [];
    expect(() =>
      checkMacCore({
        socket: '/private/missing.sock',
        exists: () => false,
        run: (args: string[]) => {
          calls.push(args);
          return '';
        },
      }),
    ).toThrow(/did not create.*missing.sock/);
    expect(calls).toEqual([
      ['server', 'start'],
      ['server', 'stop'],
    ]);
  });

  it('runs a live terminal and fails if final cleanup fails', () => {
    const calls: string[][] = [];
    expect(() =>
      checkMacCore({
        socket: '/private/core.sock',
        exists: () => true,
        log: () => {},
        run: (args: string[]) => {
          calls.push(args);
          if (args[1] === 'stop') throw new Error('stop failed');
          return JSON.stringify({ terminals: [{ name: 'smoke', state: 'live' }] });
        },
      }),
    ).toThrow('stop failed');
    expect(calls.map((args) => args[0])).toEqual(['server', 'run', 'ls', 'server']);
  });
});
