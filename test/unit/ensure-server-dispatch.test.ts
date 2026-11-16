import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runServer } from '../../server/main';

describe('--ensure-server dispatch', () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('exits 2 with usage on stderr for bad args, without listening or writing a secret', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-args-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await runServer(['--ensure-server', '--user-data', dir, '--start', 'nope']);
    expect(result.code).toBe(2);
    expect(result.transport).toBeUndefined();
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(
      /usage:.*--ensure-server.*--start/s,
    );
    expect(existsSync(join(dir, 'server-secret'))).toBe(false);
  });

  it('exits 2 for a relative --shim-dir before any start', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-shim-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await runServer([
      '--ensure-server',
      '--user-data',
      dir,
      '--start',
      'plain',
      '--survives-logout',
      'yes',
      '--shim-dir',
      'relative/shim',
    ]);
    expect(result.code).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(
      /--shim-dir must be an absolute path/,
    );
    expect(existsSync(join(dir, 'server-secret'))).toBe(false);
  });
});
