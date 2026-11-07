/**
 * sidebar-multi-close (CON-167): Ctrl-select two agent rows, right-click › Close 2 sessions,
 * confirm once, and only the two selected sessions close. The third row stays.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, removeDir, runScenario, tapBridge } from './harness.mjs';
import { killAll, row } from './sidebar-tree-helpers.mjs';

await runScenario('sidebar-multi-close', async ({ page, log }) => {
  await tapBridge(page);
  // Separate folders: openRepo on a folder that already has a session would reuse it.
  const root = mkdtempSync(join(tmpdir(), 'conduit-multi-close-'));
  const ids = [];
  for (const name of ['one', 'two', 'three']) {
    const dir = join(root, name);
    mkdirSync(dir);
    ids.push(await openSession(page, { path: dir, agentId: 'shell:cmd' }));
  }
  const [first, second, third] = ids;
  for (const id of ids) {
    await page.waitForFunction(
      (sid) => (window.__sessions || []).find((s) => s.id === sid)?.status === 'running',
      id,
      { timeout: 15000 },
    );
  }
  log('three shell sessions running');

  await row(page, first).locator('[data-agent-action="select"]').click();
  await row(page, second)
    .locator('[data-agent-action="select"]')
    .click({ modifiers: ['Control'] });
  await page.waitForFunction(
    (sid) =>
      document.querySelector(`.session[data-sessionid="${sid}"]`)?.getAttribute('aria-selected') ===
      'true',
    second,
    { timeout: 5000 },
  );
  log('first and second selected');

  await row(page, second).click({ button: 'right' });
  await page.locator('.ctxmenu__item', { hasText: 'Close 2 sessions' }).click();
  await page
    .locator('.confirm[role="alertdialog"]')
    .getByRole('button', { name: 'Close 2 sessions', exact: true })
    .click();

  await page.waitForFunction(
    (gone) => gone.every((sid) => !(window.__sessions || []).some((s) => s.id === sid)),
    [first, second],
    { timeout: 20000 },
  );
  const thirdLeft = await page.evaluate(
    (sid) => (window.__sessions || []).some((s) => s.id === sid),
    third,
  );
  assert(thirdLeft, 'the unselected third session was closed too');
  log('selected two closed, third remains');

  await killAll(page);
  removeDir(root);
});
