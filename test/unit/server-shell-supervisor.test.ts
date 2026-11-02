import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { supervise } from '../../server/supervise';
import {
  SERVER_EXHAUSTED_FILE,
  SERVER_FILE_VERSION,
  SUPERVISOR_EXHAUSTED_COOLDOWN_MS,
} from '../../src/contracts/session-identity';

const MINUTE = 60_000;

function harness(exitCodes: Array<number | null>) {
  let time = Date.UTC(2026, 0, 1);
  const sleeps: number[] = [];
  const spawnCount = { value: 0 };
  const spawnChild = async () => {
    const code = exitCodes[spawnCount.value++];
    if (code === undefined) throw new Error('unexpected child spawn');
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
    },
    sleeps,
    spawnCount,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

async function withScratch<T>(run: (userData: string) => Promise<T>): Promise<T> {
  const scratchRoot = path.join(tmpdir(), 'Codex-scratch');
  await mkdir(scratchRoot, { recursive: true });
  const userData = await mkdtemp(path.join(scratchRoot, 'supervisor-marker-'));
  try {
    return await run(userData);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
}

describe('server supervisor', () => {
  it('uses the capped backoff sequence for crashes spaced outside the exhaustion window', async () => {
    const h = harness([1, 2, 4, 5, 6, 0]);
    const spawn = h.options.spawnChild;
    h.options.spawnChild = async () => {
      const code = await spawn();
      h.advance(11 * MINUTE);
      return code;
    };

    await expect(supervise(h.options)).resolves.toBe(0);

    expect(h.sleeps).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
    expect(h.spawnCount.value).toBe(6);
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

  it('never overwrites a newer filesystem marker version', async () => {
    await withScratch(async (userData) => {
      const markerPath = path.join(userData, SERVER_EXHAUSTED_FILE);
      const newerMarker = {
        version: SERVER_FILE_VERSION[SERVER_EXHAUSTED_FILE] + 1,
        payload: 'preserve',
      };
      await writeFile(markerPath, JSON.stringify(newerMarker));
      let spawnCount = 0;
      let time = Date.UTC(2026, 0, 1);

      await expect(
        supervise({
          userData,
          logPath: path.join(userData, 'server.log'),
          spawnChild: async () => [1, 2, 4, 5, 6, 0][spawnCount++],
          sleep: async (ms) => {
            time += ms;
            if (spawnCount === 5) await rm(markerPath, { force: true });
          },
          now: () => time,
        }),
      ).rejects.toThrow(`Refusing to overwrite newer ${SERVER_EXHAUSTED_FILE}`);

      await expect(readFile(markerPath, 'utf8')).resolves.toBe(JSON.stringify(newerMarker));
      expect(spawnCount).toBe(5);
    });
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
