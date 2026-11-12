/**
 * Explorer git-ignored dimming (real-app smoke).
 *
 * The Explorer shows build/dependency dirs (only VCS/OS metadata is hidden), but
 * git-ignored entries are dimmed (filerow--ignored). Drives the real app + the host
 * `git check-ignore` round-trip: node_modules (ignored) is dimmed; src (tracked) is not.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assert,
  fixtureMkdtemp,
  openSession,
  REPO,
  runScenario,
  showRightView,
} from './harness.mjs';

/**
 * On Linux the worktree's node_modules is a symlink, and gitignore's `node_modules/` pattern only
 * matches a real directory, so the scenario builds its own repo there. Windows keeps REPO.
 */
function ignoredFixtureRepo() {
  if (process.platform === 'win32') return REPO;
  const root = fixtureMkdtemp('conduit-gitignore-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'module.exports = {};\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
  return root;
}

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name}$`) }),
  });

runScenario('explorer-gitignore', async ({ page, log }) => {
  await openSession(page, { path: ignoredFixtureRepo() });
  await showRightView(page, 'files');
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 20000 });

  const nm = fileRow(page, 'node_modules').first();
  await nm.waitFor({ state: 'attached', timeout: 20000 });
  const nmClass = (await nm.getAttribute('class')) ?? '';
  assert(nmClass.includes('filerow--ignored'), 'node_modules (git-ignored) should be dimmed');
  log('node_modules dimmed ✓');

  const src = fileRow(page, 'src').first();
  await src.waitFor({ state: 'attached', timeout: 20000 });
  const srcClass = (await src.getAttribute('class')) ?? '';
  assert(!srcClass.includes('filerow--ignored'), 'src (tracked) should NOT be dimmed');
  log('src not dimmed ✓');
});
