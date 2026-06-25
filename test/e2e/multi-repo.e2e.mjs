/**
 * Multi-repo awareness (real-app smoke). Crosses the host/IPC boundary (detection runs
 * host-side; the active-repo state rides the `state` broadcast), so it must drive the REAL
 * app, not the mock preview. Verifies, against the real renderer + host:
 *  - a folder containing two git repos shows the repo picker listing both;
 *  - picking a repo pins it and re-scopes the host's active repo (asserted via bridge state);
 *  - a pin survives an auto-follow trigger (a `repo:context` for another repo is ignored).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

function makeRepo(dir, file, committed, working) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, file), committed);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  writeFileSync(join(dir, file), working); // leave an uncommitted change
}

runScenario('multi-repo', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-multirepo-'));
  makeRepo(join(root, 'repo-a'), 'a.txt', 'a1\n', 'a2\n');
  makeRepo(join(root, 'repo-b'), 'b.txt', 'b1\n', 'b2\n');

  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });

  // Detection runs host-side after open; wait for the two repos to land on the session state.
  await page.waitForFunction(
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return (s?.repos?.length ?? 0) >= 2;
    },
    sid,
    { timeout: 20000 },
  );
  log('two sub-repos detected ✓');

  const picker = page.locator('.repo-picker__trigger');
  await picker.waitFor({ state: 'visible', timeout: 10000 });

  // The picker lists both repos.
  await picker.click();
  await page.locator('.repo-picker-menu').waitFor({ state: 'visible', timeout: 10000 });
  const names = await page.locator('.repo-picker-menu__name').allInnerTexts();
  assert(
    names.some((n) => n.includes('repo-a')),
    'menu lists repo-a',
  );
  assert(
    names.some((n) => n.includes('repo-b')),
    'menu lists repo-b',
  );
  log('picker lists repo-a + repo-b ✓');

  // Pick repo-b → host pins it + re-scopes (asserted via the broadcast state, the source of truth).
  await page.locator('.repo-picker-menu__row', { hasText: 'repo-b' }).first().click();
  await page.waitForFunction(
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return (
        !!s &&
        s.repoPinned === true &&
        (s.activeRepoRoot || '').replace(/\\/g, '/').endsWith('repo-b')
      );
    },
    sid,
    { timeout: 10000 },
  );
  log('picked + pinned repo-b ✓');

  // A pin survives an auto-follow trigger: a repo:context for repo-a must be ignored while pinned.
  await page.evaluate(
    ({ id, p }) => window.agentDeck.post({ type: 'repo:context', sessionId: id, path: p }),
    { id: sid, p: join(root, 'repo-a', 'a.txt').replace(/\\/g, '/') },
  );
  // Give the host a beat to process; then assert the active repo is still the pinned repo-b.
  await page.waitForTimeout(400);
  const stillB = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return (
      !!s &&
      s.repoPinned === true &&
      (s.activeRepoRoot || '').replace(/\\/g, '/').endsWith('repo-b')
    );
  }, sid);
  assert(stillB, 'pin holds across an auto-follow trigger (repo:context ignored while pinned)');

  log('PASS ✓ multi-repo picker lists repos, pins selection, pin survives auto-follow');
});
