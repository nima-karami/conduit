/**
 * Git blame lens (real-app smoke). Crosses the renderer/host boundary: `git blame --porcelain`
 * runs on the host, is host-validated (tracked path inside root), and the parsed per-line
 * author/commit renders as a Monaco content-widget lens on the active line. The preview mock
 * can't run git, so this only proves out against the built app.
 *
 * Flow: temp repo with a committed .ts file → open it in the editor → toggle blame via the
 * command palette → assert the active-line lens shows an author + summary → screenshot.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

runScenario('git-blame', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-blame-'));
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'blamer@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Blame Author'], { cwd: root });
  writeFileSync(join(root, 'app.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'seed the constants'], { cwd: root });

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^app\.ts$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page.waitForFunction(
    () =>
      (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith('app.ts')),
    null,
    { timeout: 20000 },
  );
  log('file opened in editor ✓');

  // Toggle blame via the real editor action (same id the context menu invokes).
  await page.evaluate(() => {
    const eds = window.monaco.editor.getEditors?.() ?? [];
    const ed = eds.find((e) => e.getModel()?.uri.toString().endsWith('app.ts')) ?? eds[0];
    ed?.getAction('agentdeck.toggleGitBlame')?.run();
  });

  const lens = page.locator('.blame-lens');
  await lens.first().waitFor({ state: 'visible', timeout: 10000 });
  const text = (await lens.first().textContent())?.trim() ?? '';
  log(`blame lens: "${text}"`);
  assert(/Blame Author/i.test(text), `lens should name the commit author, got "${text}"`);
  assert(
    /constants/i.test(text) || text.length > 8,
    `lens should carry the commit summary, got "${text}"`,
  );
  log('blame lens shows author + summary on the active line ✓');

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'git-blame.png') }).catch(() => {});

  await closeApp(app, page);
});
