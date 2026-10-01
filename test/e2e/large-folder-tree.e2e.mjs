import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

runScenario('large-folder-tree', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-large-tree-'));
  try {
    for (let i = 0; i < 1000; i++) {
      mkdirSync(join(root, `group-${i}`, 'empty'), { recursive: true });
    }
    for (let i = 0; i < 24; i++) {
      const repo = join(root, `group-${i}`, 'repo');
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', repo], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
      });
      writeFileSync(join(repo, 'fixture.ts'), 'export const fixture = 1;\n');
    }
    await app.evaluate(() => {
      globalThis.__treePulse = { ticks: 0, gap: 0, last: Date.now() };
      globalThis.__treeTimer = setInterval(() => {
        const pulse = globalThis.__treePulse;
        const now = Date.now();
        pulse.gap = Math.max(pulse.gap, now - pulse.last);
        pulse.last = now;
        pulse.ticks++;
      }, 10);
    });
    const folder = root.replace(/\\/g, '/');
    const id = await openSession(page, { path: folder });
    await page.waitForFunction(
      (sid) => window.__sessions?.find((s) => s.id === sid)?.repos?.length === 24,
      id,
      { timeout: 30000 },
    );
    await page.evaluate((p) => {
      window.__treeSearch = undefined;
      window.agentDeck.subscribe((m) => {
        if (m.type === 'searchResults' && m.root === p) window.__treeSearch = m.results;
      });
      window.agentDeck.post({ type: 'searchFiles', root: p });
    }, folder);
    await page.waitForFunction(() => window.__treeSearch?.length === 24, null, {
      timeout: 30000,
    });
    const pulse = await app.evaluate(() => {
      clearInterval(globalThis.__treeTimer);
      return globalThis.__treePulse;
    });
    assert(pulse.ticks > 0, 'host timers ran during session discovery and indexing');
    assert(pulse.gap < 1000, `host stayed responsive; largest timer gap ${pulse.gap}ms`);
    log(`24 nested repos and 24 source files found; largest host timer gap ${pulse.gap}ms`);
  } finally {
    await closeApp(app, page);
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
