import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-attempt completeness sentinel the nightly's coverage map trusts (spec §B2): how many apps
 * the attempt launched, the most windows one of them opened, how many it stopped cleanly, and what
 * was lost. Driven through a fake Playwright app; the real CDP path is covered by the nightly.
 */

const root = mkdtempSync(join(tmpdir(), 'cov-capture-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Page = { closed?: boolean };
function fakeApp({ hostFails = false } = {}) {
  const onWindow: ((p: Page) => void)[] = [];
  const pages: Page[] = [{}];
  const app = {
    evaluate: async (_fn: unknown, arg?: unknown) => {
      if (hostFails) throw new Error('host gone');
      return arg ? true : [];
    },
    context: () => ({
      newCDPSession: async (page: Page) => ({
        send: async (method: string) => {
          if (method !== 'Profiler.takePreciseCoverage') return {};
          if (page.closed) throw new Error('Target closed');
          return { result: [] };
        },
      }),
    }),
    on: (event: string, cb: (p: Page) => void) => {
      if (event === 'window') onWindow.push(cb);
    },
    windows: () => pages,
    close: async () => {},
    openWindow: () => {
      const p: Page = {};
      pages.push(p);
      for (const cb of onWindow) cb(p);
      return p;
    },
  };
  return app;
}

let n = 0;
let dir = '';
beforeEach(() => {
  vi.resetModules();
  dir = join(root, `run-${n++}`);
  vi.stubEnv('E2E_COVERAGE_DIR', dir);
  vi.stubEnv('E2E_SCENARIO', 'scn');
});

const load = () => import('../e2e/coverage-capture.mjs');
const meta = () =>
  JSON.parse(readFileSync(join(dir, 'scn', `meta-${process.pid}.json`), 'utf8')) as {
    launches: number;
    windows: number;
    stopped: number;
    incomplete: string[];
  };

describe('coverage completeness sentinel', () => {
  it('one app, stopped cleanly: complete', async () => {
    const { startCoverage, stopCoverage } = await load();
    const app = fakeApp();
    startCoverage(app, () => {});
    expect(meta()).toMatchObject({ launches: 1, stopped: 0 });
    await stopCoverage(app);
    expect(meta()).toEqual({ launches: 1, windows: 1, stopped: 1, incomplete: [] });
  });

  it('a relaunch and a second window are counted', async () => {
    const { startCoverage, stopCoverage } = await load();
    const a = fakeApp();
    startCoverage(a, () => {});
    a.openWindow();
    await stopCoverage(a);
    const b = fakeApp();
    startCoverage(b, () => {});
    await stopCoverage(b);
    expect(meta()).toMatchObject({ launches: 2, windows: 2, stopped: 2, incomplete: [] });
  });

  it('a window closed before stop, or a host that never answered, is recorded as lost', async () => {
    const { startCoverage, stopCoverage } = await load();
    const a = fakeApp();
    startCoverage(a, () => {});
    a.openWindow().closed = true;
    await stopCoverage(a);
    expect(meta().incomplete).toEqual(['a window closed before its coverage was taken']);
    const b = fakeApp({ hostFails: true });
    startCoverage(b, () => {});
    await stopCoverage(b);
    expect(meta().incomplete).toContain('host coverage never started');
  });

  it('a capture the harness gave up on is marked incomplete', async () => {
    const { markCoverageIncomplete, startCoverage } = await load();
    const app = fakeApp();
    startCoverage(app, () => {});
    markCoverageIncomplete('coverage capture timed out');
    expect(meta()).toMatchObject({ stopped: 0, incomplete: ['coverage capture timed out'] });
  });
});
