import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { fileManagerPreference } from '../../src/os-integration/preference';
import { windowsIntegration, windowsRegistry } from '../../src/os-integration/windows';

const { reg } = vi.hoisted(() => ({ reg: vi.fn<(args: string[]) => number>() }));

vi.mock('node:child_process', () => ({
  execFile: (
    _program: string,
    args: string[],
    _options: unknown,
    done: (error: { code: number } | null) => void,
  ) => {
    const code = reg(args);
    done(code === 0 ? null : { code });
  },
}));

test('startup removes restored Windows keys only for a persisted off preference', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'conduit-registry-preference-'));
  const executable = 'C:\\Program Files\\Conduit.exe';
  const root = 'HKCU\\Software\\ConduitE2E';
  const { keys, registered } = windowsRegistry(executable);
  const owned = [...keys, registered].map((key) => `${root}\\${key}`);
  const current = new Set(owned);
  reg.mockImplementation(([action, key]) => {
    if (action === 'query') return current.has(key) ? 0 : 1;
    if (action === 'delete') return current.delete(key) ? 0 : 1;
    if (action === 'add') return 0;
    throw new Error(`Unexpected registry operation ${action}`);
  });

  try {
    const open = () => fileManagerPreference(userData, windowsIntegration(executable, root));
    await open().reconcileStartup();
    expect(reg).not.toHaveBeenCalled();

    await open().setEnabled(false);
    expect(current.size).toBe(0);
    expect(
      JSON.parse(readFileSync(join(userData, 'file-manager-preference.json'), 'utf8')),
    ).toEqual({
      enabled: false,
    });

    for (const key of owned) current.add(key);
    await open().reconcileStartup();
    expect(current.size).toBe(0);

    await open().setEnabled(true);
    for (const key of owned) current.add(key);
    reg.mockClear();
    await open().reconcileStartup();
    expect(reg).not.toHaveBeenCalled();
    expect(current.size).toBe(owned.length);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
