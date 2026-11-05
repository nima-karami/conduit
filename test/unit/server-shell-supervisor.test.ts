import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directStopAll } from '../../server/hc-cli';
import { serverChildEnv, spawnServerChild, supervise } from '../../server/supervise';
import {
  SERVER_EXHAUSTED_FILE,
  SERVER_FILE_VERSION,
  SUPERVISOR_EXHAUSTED_COOLDOWN_MS,
  SUPERVISOR_MARKER_POLL_MS,
} from '../../src/contracts/session-identity';
import { instanceNames } from '../../src/instance-names';

const posixOptions = { home: '/home/conduit-test', uid: 1000, runtimeDir: '' };

const fsHooks = vi.hoisted(() => ({ renameError: undefined as Error | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsHooks.renameError) throw fsHooks.renameError;
      return actual.rename(...args);
    },
  };
});
afterEach(() => {
  fsHooks.renameError = undefined;
});

const MINUTE = 60_000;

function harness(exitCodes: Array<number | null | Error>) {
  let time = Date.UTC(2026, 0, 1);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const spawnCount = { value: 0 };
  const spawnChild = async () => {
    const code = exitCodes[spawnCount.value++];
    if (code === undefined) throw new Error('unexpected child spawn');
    if (code instanceof Error) throw code;
    return code;
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    time += ms;
  };
  return {
    options: {
      userData: '/profile',
      logPath: '/profile/server.log',
      spawnChild,
      sleep,
      now: () => time,
      log: (message: string) => {
        logs.push(message);
      },
    },
    sleeps,
    logs,
    spawnCount,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

async function withScratch<T>(run: (userData: string) => Promise<T>): Promise<T> {
  const userData = await mkdtemp(path.join(tmpdir(), 'w3-test-supervisor-'));
  try {
    return await run(userData);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
}

const crashRun = [1, 2, 4, 5, 6, 0];

describe('server supervisor', () => {
  it('direct stop re-lists after targeted kills and leaves a core with another live terminal', async () => {
    const names = instanceNames('/profile', 'posix', '/tmp', posixOptions);
    const calls: string[] = [];
    let stopped = false;
    const hc = {
      call: async (method: string) => {
        calls.push(method);
        if (method === 'terminal.list') {
          return calls.filter((call) => call === 'terminal.list').length === 1
            ? { terminals: [{ address: 'session-1', state: 'live', name: 'session-1' }] }
            : {
                terminals: [{ address: 'other-1', state: 'live', name: 'unrelated' }],
              };
        }
        if (method === 'terminal.get')
          return { address: 'supervisor-1', state: 'exited', name: names.supervisorName };
        return {};
      },
      close: () => calls.push('close'),
    } as unknown as import('../../src/contracts/hc').HcClient;

    await directStopAll(hc, names, async () => {
      stopped = true;
    });

    expect(calls.filter((call) => call === 'terminal.list')).toHaveLength(2);
    expect(calls).toContain('terminal.kill');
    expect(stopped).toBe(false);
  });

  it('direct stop leaves the core running when the final terminal listing fails', async () => {
    const names = instanceNames('/profile', 'posix', '/tmp', posixOptions);
    let listCalls = 0;
    let stopped = false;
    const hc = {
      call: async (method: string) => {
        if (method === 'terminal.list' && ++listCalls === 2) throw new Error('listing failed');
        if (method === 'terminal.list') return { terminals: [] };
        if (method === 'terminal.get')
          return { address: 'supervisor-1', state: 'exited', name: names.supervisorName };
        return {};
      },
      close: () => {},
    } as unknown as import('../../src/contracts/hc').HcClient;

    await expect(
      directStopAll(hc, names, async () => {
        stopped = true;
      }),
    ).rejects.toThrow('listing failed');

    expect(listCalls).toBe(2);
    expect(stopped).toBe(false);
  });

  it('restarts the backoff for crashes spaced outside the exhaustion window', async () => {
    const h = harness(crashRun);
    const spawn = h.options.spawnChild;
    h.options.spawnChild = async () => {
      const code = await spawn();
      h.advance(11 * MINUTE);
      return code;
    };

    await expect(supervise(h.options)).resolves.toBe(0);

    expect(h.sleeps).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(h.spawnCount.value).toBe(6);
  });

  it('indexes the backoff by the crashes still inside the window', async () => {
    const h = harness([1, 2, 4, 5, 0]);
    const spawn = h.options.spawnChild;
    h.options.spawnChild = async () => {
      const code = await spawn();
      if (h.spawnCount.value === 3) h.advance(11 * MINUTE);
      return code;
    };

    await expect(supervise(h.options)).resolves.toBe(0);

    expect(h.sleeps).toEqual([1_000, 2_000, 1_000, 2_000]);
  });

  it('counts a failed spawn as a crash instead of exiting', async () => {
    const h = harness([new Error('spawn EACCES'), 0]);

    await expect(supervise(h.options)).resolves.toBe(0);

    expect(h.sleeps).toEqual([1_000]);
    expect(h.spawnCount.value).toBe(2);
    expect(h.logs.join('\n')).toContain('spawn EACCES');
  });

  it('logs a failed marker write and still cools down before trying again', async () => {
    const h = harness(crashRun);
    const marker = {
      write: async () => {
        throw new Error('EPERM marker');
      },
      exists: async () => false,
      remove: async () => {},
    };

    await expect(supervise({ ...h.options, marker })).resolves.toBe(0);

    expect(h.sleeps.slice(4).reduce((a, b) => a + b, 0)).toBe(SUPERVISOR_EXHAUSTED_COOLDOWN_MS);
    expect(h.spawnCount.value).toBe(6);
    expect(h.logs.join('\n')).toContain('EPERM marker');
  });

  it('writes exhaustion on the fifth crash and polls only at the cooldown interval', async () => {
    const h = harness([1, 2, 4, 5, 6, 0]);
    let markerExists = false;
    let written: unknown;
    let polls = 0;
    h.options.sleep = async (ms) => {
      h.sleeps.push(ms);
      if (ms === 5_000 && ++polls === 3) markerExists = false;
    };
    const marker = {
      write: async (value: unknown) => {
        markerExists = true;
        written = value;
        return 'written' as const;
      },
      exists: async () => markerExists,
      remove: async () => {
        markerExists = false;
      },
    };

    await expect(supervise({ ...h.options, marker })).resolves.toBe(0);

    expect(written).toMatchObject({ lastExitCode: 6, logPath: '/profile/server.log' });
    expect(h.sleeps).toEqual([1_000, 2_000, 5_000, 10_000, 5_000, 5_000]);
    expect(h.spawnCount.value).toBe(6);
  });

  it('retries immediately when the app deletes the exhaustion marker', async () => {
    const h = harness([1, 2, 4, 5, 6, 0]);
    let markerExists = false;
    const marker = {
      write: async () => {
        markerExists = true;
        return 'written' as const;
      },
      exists: async () => markerExists,
      remove: async () => {
        markerExists = false;
      },
    };
    h.options.sleep = async (ms) => {
      h.sleeps.push(ms);
      h.advance(ms);
      if (ms === 5_000) markerExists = false;
    };

    await expect(supervise({ ...h.options, marker })).resolves.toBe(0);

    expect(h.spawnCount.value).toBe(6);
    expect(h.sleeps.slice(4)).toEqual([5_000]);
  });

  it('removes the marker and resumes after the full cooldown', async () => {
    const h = harness([1, 2, 4, 5, 6, 0]);
    let markerExists = false;
    let removed = false;
    const marker = {
      write: async () => {
        markerExists = true;
        return 'written' as const;
      },
      exists: async () => markerExists,
      remove: async () => {
        markerExists = false;
        removed = true;
      },
    };
    h.options.sleep = async (ms) => {
      h.sleeps.push(ms);
      h.advance(ms);
    };

    await expect(supervise({ ...h.options, marker })).resolves.toBe(0);

    expect(removed).toBe(true);
    expect(markerExists).toBe(false);
    expect(h.sleeps).toHaveLength(364);
    expect(h.sleeps.slice(4).every((ms) => ms === 5_000)).toBe(true);
    expect(h.spawnCount.value).toBe(6);
  });

  it('writes a versioned filesystem marker with its exhaustion timestamps', async () => {
    await withScratch(async (userData) => {
      const start = Date.UTC(2026, 0, 1);
      let time = start;
      let spawnCount = 0;
      const markerPath = path.join(userData, SERVER_EXHAUSTED_FILE);
      let written: unknown;
      await expect(
        supervise({
          userData,
          logPath: path.join(userData, 'server.log'),
          spawnChild: async () => [1, 2, 4, 5, 6, 0][spawnCount++],
          now: () => time,
          sleep: async (ms) => {
            time += ms;
            if (spawnCount === 5 && ms === 5_000) {
              written = JSON.parse(await readFile(markerPath, 'utf8'));
              await rm(markerPath);
            }
          },
        }),
      ).resolves.toBe(0);

      expect(written).toEqual({
        version: SERVER_FILE_VERSION[SERVER_EXHAUSTED_FILE],
        at: new Date(start + 18_000).toISOString(),
        retryAt: new Date(start + 18_000 + SUPERVISOR_EXHAUSTED_COOLDOWN_MS).toISOString(),
        lastExitCode: 6,
        logPath: path.join(userData, 'server.log'),
      });
    });
  });

  it('treats a newer marker as its own: never touches it, cools down, then carries on', async () => {
    await withScratch(async (userData) => {
      const markerPath = path.join(userData, SERVER_EXHAUSTED_FILE);
      const newerMarker = JSON.stringify({
        version: SERVER_FILE_VERSION[SERVER_EXHAUSTED_FILE] + 1,
        payload: 'preserve',
      });
      await writeFile(markerPath, newerMarker);
      let spawnCount = 0;
      let time = Date.UTC(2026, 0, 1);
      const sleeps: number[] = [];

      await expect(
        supervise({
          userData,
          logPath: path.join(userData, 'server.log'),
          spawnChild: async () => crashRun[spawnCount++],
          sleep: async (ms) => {
            sleeps.push(ms);
            time += ms;
          },
          now: () => time,
          log: () => {},
        }),
      ).resolves.toBe(0);

      await expect(readFile(markerPath, 'utf8')).resolves.toBe(newerMarker);
      expect(spawnCount).toBe(6);
      expect(sleeps.slice(4)).toEqual(
        Array(SUPERVISOR_EXHAUSTED_COOLDOWN_MS / SUPERVISOR_MARKER_POLL_MS).fill(
          SUPERVISOR_MARKER_POLL_MS,
        ),
      );
    });
  });

  it('retries now when the app deletes a newer marker it is polling', async () => {
    await withScratch(async (userData) => {
      const markerPath = path.join(userData, SERVER_EXHAUSTED_FILE);
      await writeFile(
        markerPath,
        JSON.stringify({ version: SERVER_FILE_VERSION[SERVER_EXHAUSTED_FILE] + 1 }),
      );
      let spawnCount = 0;
      const sleeps: number[] = [];

      await expect(
        supervise({
          userData,
          logPath: path.join(userData, 'server.log'),
          spawnChild: async () => crashRun[spawnCount++],
          sleep: async (ms) => {
            sleeps.push(ms);
            if (spawnCount === 5) await rm(markerPath, { force: true });
          },
          now: () => Date.UTC(2026, 0, 1),
          log: () => {},
        }),
      ).resolves.toBe(0);

      expect(spawnCount).toBe(6);
      expect(sleeps.slice(4)).toEqual([SUPERVISOR_MARKER_POLL_MS]);
    });
  });

  it.each(['EPERM', 'EBUSY'])(
    'logs a %s marker rename, removes its temp file and still cools down',
    async (code) => {
      await withScratch(async (userData) => {
        fsHooks.renameError = Object.assign(new Error(`${code}: rename`), { code });
        let spawnCount = 0;
        let time = Date.UTC(2026, 0, 1);
        const sleeps: number[] = [];
        const logs: string[] = [];

        await expect(
          supervise({
            userData,
            logPath: path.join(userData, 'server.log'),
            spawnChild: async () => crashRun[spawnCount++],
            sleep: async (ms) => {
              sleeps.push(ms);
              time += ms;
            },
            now: () => time,
            log: (message) => {
              logs.push(message);
            },
          }),
        ).resolves.toBe(0);

        expect(spawnCount).toBe(6);
        expect(sleeps.slice(4).reduce((a, b) => a + b, 0)).toBe(SUPERVISOR_EXHAUSTED_COOLDOWN_MS);
        expect(logs.join('\n')).toContain(`${code}: rename`);
        expect(await readdir(userData)).toEqual([]);
      });
    },
  );

  it('resolves a spawn error as a crash exit instead of rejecting', async () => {
    const missing = path.join(tmpdir(), 'w3-test-no-such-binary', 'node');
    const logs: string[] = [];
    await expect(
      spawnServerChild(missing, [], {}, tmpdir(), (message) => {
        logs.push(message);
      }),
    ).resolves.toBeNull();
    expect(logs.join('\n')).toContain('ENOENT');
  });

  it('keeps the XDG isolation decided at the supervisor start (C4 coreStartEnv)', () => {
    const names = instanceNames('/profile', 'posix', '/tmp', posixOptions);
    const isolated = serverChildEnv(
      {
        PATH: '/bin',
        HC_SESSION: 'other',
        XDG_CONFIG_HOME: names.hcConfigHome,
        XDG_STATE_HOME: '/home/u/.local/state',
        CONDUIT_USER_XDG_CAPTURED: '1',
        CONDUIT_USER_XDG_CONFIG_HOME: '/home/u/.config',
        CONDUIT_USER_XDG_STATE_HOME: '/home/u/.local/state',
      },
      names,
    );
    expect(isolated).toMatchObject({
      XDG_CONFIG_HOME: names.hcConfigHome,
      XDG_STATE_HOME: names.hcStateHome,
      CONDUIT_USER_XDG_CONFIG_HOME: '/home/u/.config',
      CONDUIT_USER_XDG_STATE_HOME: '/home/u/.local/state',
      HC_SESSION: names.hcSession,
    });
    const standalone = serverChildEnv({ PATH: '/bin', XDG_CONFIG_HOME: '/home/u/.config' }, names);
    expect(standalone.XDG_CONFIG_HOME).toBe(names.hcConfigHome);
    expect(standalone.XDG_STATE_HOME).toBe(names.hcStateHome);
  });

  it('returns normally on SERVER_EXIT.done without stopping the core', async () => {
    const h = harness([0]);
    let stopped = false;

    await expect(
      supervise({
        ...h.options,
        core: {
          hasOtherLiveTerminals: async () => false,
          stop: async () => {
            stopped = true;
          },
        },
      }),
    ).resolves.toBe(0);

    expect(stopped).toBe(false);
    expect(h.spawnCount.value).toBe(1);
  });

  it('does not stop the core after doneCoreIdle while another terminal is live', async () => {
    const h = harness([3]);
    let stopped = false;

    await expect(
      supervise({
        ...h.options,
        core: {
          hasOtherLiveTerminals: async () => true,
          stop: async () => {
            stopped = true;
          },
        },
      }),
    ).resolves.toBe(0);

    expect(stopped).toBe(false);
    expect(h.spawnCount.value).toBe(1);
  });

  it('stops an idle core after doneCoreIdle when no other terminal is live', async () => {
    const h = harness([3]);
    let stopped = false;

    await expect(
      supervise({
        ...h.options,
        core: {
          hasOtherLiveTerminals: async () => false,
          stop: async () => {
            stopped = true;
          },
        },
      }),
    ).resolves.toBe(0);

    expect(stopped).toBe(true);
  });
});
