import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs harness module, no declarations
import * as td from '../e2e/harness-server-teardown.mjs';

const BS = String.fromCharCode(92);
const DIR = ['C:', 'Users', 'Me', 'AppData', 'Local', 'Temp', 'conduit-ud-solo-1-abc'].join(BS);
const names = td.teardownNames(DIR, 'win32', '/tmp');
const instance = names.hcSession.replace('conduit-', '');

const holder = (inst: string) => ({
  ProcessId: 10,
  Name: 'hc.exe',
  CommandLine: `hc.exe hold --socket ${BS}${BS}.${BS}pipe${BS}herdr-core-me-conduit-${inst}.holder.1.sock`,
});

describe('profileLeftovers', () => {
  it('finds the holder of this profile only', () => {
    const procs = [holder(instance), holder('0000000000000000')];
    const ids = td
      .profileLeftovers(procs, DIR, names)
      .map((p: { ProcessId: number }) => p.ProcessId);
    expect(ids).toEqual([10]);
    expect(td.profileLeftovers([procs[1]], DIR, names)).toEqual([]);
  });

  it('finds a process whose command line names the profile dir, any slash or case', () => {
    const upper = { ProcessId: 7, CommandLine: `electron "--user-data-dir=${DIR.toUpperCase()}"` };
    const fwd = { ProcessId: 8, CommandLine: DIR.split(BS).join('/') };
    expect(td.profileLeftovers([upper, fwd], DIR, names)).toHaveLength(2);
  });

  it('ignores unrelated and command-less processes', () => {
    const procs = [
      { ProcessId: 1, CommandLine: null },
      { ProcessId: 2, CommandLine: 'hc.exe serve' },
    ];
    expect(td.profileLeftovers(procs, DIR, names)).toEqual([]);
  });
});

describe('teardownScenarioServer leftovers', () => {
  const run = async (listProcs: () => unknown[]) => {
    const logs: string[] = [];
    await td.teardownScenarioServer({
      userDataDir: DIR,
      tmpdir: '/tmp',
      platform: 'win32',
      env: {},
      appVersion: '1.0.0',
      stopAll: async () => ({ outcome: 'no-server' }),
      exec: () => ({ status: 0 }),
      listProcs,
      waitMs: 0,
      log: (...a: unknown[]) => logs.push(a.join(' ')),
    });
    return logs;
  };

  it('is silent when the profile has nothing left', async () => {
    expect((await run(() => [])).some((l) => l.includes('STILL RUNNING'))).toBe(false);
  });

  it('names what survived', async () => {
    const logs = await run(() => [holder(instance)]);
    expect(logs.some((l) => l.includes('STILL RUNNING') && l.includes('10 hc.exe'))).toBe(true);
  });
});
