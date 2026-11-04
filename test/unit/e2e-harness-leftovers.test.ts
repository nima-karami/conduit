import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

// See docs/runs/2026-11-02-hc-spike/raw/m21.txt:3-5; only the session token is profile-derived.
const measuredTree = [
  {
    ProcessId: 52852,
    ParentProcessId: 14508,
    Name: 'hc.exe',
    CommandLine: 'C:/outside-the-profile/rtA/hc.exe serve',
  },
  {
    ProcessId: 33024,
    ParentProcessId: 52852,
    Name: 'hc.exe',
    CommandLine: `C:/outside-the-profile/rtA/hc.exe hold --socket ${BS}${BS}.${BS}pipe${BS}herdr-core-karam-${names.hcSession}.holder.f02c7ddd.sock`,
  },
  {
    ProcessId: 52192,
    ParentProcessId: 33024,
    Name: 'OpenConsole.exe',
    CommandLine:
      '"C:/outside-the-profile/rtA/conpty/x64/OpenConsole.exe" --headless --width 200 --height 120 --signal 0x1b0 --server 0x1a0',
  },
];

describe('profileLeftovers', () => {
  it('finds the holder of this profile only', () => {
    const procs = [holder(instance), { ...holder('0000000000000000'), ProcessId: 20 }];
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

  it('excludes the teardown process even when its command line names the profile', () => {
    const self = { ProcessId: process.pid, Name: 'node.exe', CommandLine: `node ${DIR}` };
    expect(td.profileLeftovers([self, holder(instance)], DIR, names)).toEqual([holder(instance)]);
  });

  it('finds the measured holder core and ConPTY child, excluding an unrelated core', () => {
    const unrelated = {
      ProcessId: 39244,
      ParentProcessId: 34448,
      CommandLine: 'C:/outside-the-profile/rtB/hc.exe serve',
    };
    expect(
      td
        .profileLeftovers([...measuredTree, unrelated], DIR, names)
        .map((p: { ProcessId: number }) => p.ProcessId),
    ).toEqual([52852, 33024, 52192]);
    expect(td.profileLeftovers([measuredTree[0], unrelated], DIR, names)).toEqual([]);
  });

  it('does not adopt a holder parent with a different executable or command', () => {
    for (const CommandLine of [
      'C:/different/hc.exe serve',
      'C:/outside-the-profile/rtA/hc.exe ls',
    ]) {
      expect(
        td
          .profileLeftovers([{ ...measuredTree[0], CommandLine }, measuredTree[1]], DIR, names)
          .map((p: { ProcessId: number }) => p.ProcessId),
      ).toEqual([33024]);
    }
  });
});

describe('profile process query', () => {
  const scan = (result: unknown) =>
    td.listProfileProcs(DIR, names, { platform: 'win32', run: () => result });

  it('distinguishes a valid empty table from failed or malformed output', () => {
    expect(scan({ status: 0, stdout: '[]' })).toEqual([]);
    expect(scan({ status: 0, stdout: JSON.stringify(measuredTree) })).toEqual(measuredTree);
    for (const stdout of ['', 'not-json', '{}', 'null', '[null]', '[{"ProcessId":4}]']) {
      expect(() => scan({ status: 0, stdout })).toThrow();
    }
    expect(() => scan({ status: 3, stdout: '[]' })).toThrow('PowerShell exit 3');
    expect(() =>
      scan({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }),
    ).toThrow('timed out');
  });

  it('passes profile and holder filters to CIM without putting the profile on argv', () => {
    let filter = '';
    let argv: string[] = [];
    const path = String.raw`C:\tmp\profile`;
    td.listProfileProcs(
      path,
      { hcSession: 'conduit-0123456789abcdef' },
      {
        platform: 'win32',
        run: (_bin: string, args: string[], opts: { env: { E2E_SCAN_FILTER: string } }) => {
          argv = args;
          filter = opts.env.E2E_SCAN_FILTER;
          return { status: 0, stdout: '[]' };
        },
      },
    );
    expect(filter).toBe(
      `ProcessId <> ${process.pid} AND (` +
        String.raw`CommandLine LIKE '%C:\\tmp\\profile%' OR ` +
        "CommandLine LIKE '%C:/tmp/profile%' OR " +
        "CommandLine LIKE '%-conduit-0123456789abcdef.holder%')",
    );
    expect(argv.join(' ')).not.toContain(path);
  });
});

it('finishScenario logs an ownHc guard refusal and still exits with the scenario code', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'conduit-unit-'));
  vi.stubEnv('HC_SESSION', 'unit-runner');
  vi.stubEnv('CONDUIT_HC_BINARY', 'unit-test-hc');
  vi.stubEnv('E2E_ARTIFACT_DIR', '');
  const logs: string[] = [];
  try {
    vi.resetModules();
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 0,
      output: [],
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
    });
    syncBuiltinESMExports();
    const harness = await import('../e2e/harness.mjs');
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`scenario exited ${code}`);
    });
    harness.ownHc(profile, ['ls']);
    const derived = td.teardownNames(
      profile,
      process.platform === 'win32' ? 'win32' : 'posix',
      tmpdir(),
    );
    vi.stubEnv('HC_SESSION', derived.hcSession);
    await expect(harness.finishScenario(7)).rejects.toThrow('scenario exited 7');
    expect(logs.join('\n')).toContain('server teardown failed:');
    expect(logs.join('\n')).toContain("refusing the runner's own hc session");
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    rmSync(profile, { recursive: true, force: true });
  }
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

  it('does not report the cleanup worker as a survivor', async () => {
    const logs = await run(() => [
      { ProcessId: process.pid, Name: 'node.exe', CommandLine: `node ${DIR}` },
    ]);
    expect(logs.some((l) => l.includes('STILL RUNNING'))).toBe(false);
  });

  it('reports a process scan failure distinctly from an empty table', async () => {
    const logs = await run(() => {
      throw Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' });
    });
    expect(logs.join('\n')).toContain('teardown: process scan failed');
    expect(logs.join('\n')).toContain('ETIMEDOUT');
    expect((await run(() => [])).join('\n')).not.toContain('process scan failed');
  });
});
