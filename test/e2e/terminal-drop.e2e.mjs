/**
 * Drag a file from the Files explorer onto the terminal to insert its path (D&D-ref).
 *
 * HTML5 drag-and-drop can't be driven by Playwright's mouse-based dragTo (it never
 * populates a real dataTransfer), so we synthesize the two ends with explicit DragEvents
 * carrying a DataTransfer:
 *  - dragstart on a file row → the tree must stamp the path under the explorer MIME;
 *  - drop on the terminal → the terminal must paste the (normalized) path, which the
 *    shell then echoes on its prompt.
 */

import { assert, openSession, REPO, runScenario, tapBridge } from './harness.mjs';

const MIME = 'application/x-conduit-path';

runScenario('terminal-drop', async ({ page, log }) => {
  await openSession(page, { path: REPO });
  await tapBridge(page);
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const pkg = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^package\.json$/ }),
  });
  await pkg.first().waitFor({ state: 'attached', timeout: 20000 });

  // ── Source: the tree's dragstart stamps the path under the explorer MIME ──────
  const stamped = await pkg.first().evaluate((el, mime) => {
    const dt = new DataTransfer();
    el.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
    return dt.getData(mime);
  }, MIME);
  assert(stamped.endsWith('package.json'), `dragstart should stamp the path, got "${stamped}"`);
  log('file row stamps the path on dragstart ✓');

  // ── Target: dropping on the terminal pastes the path (the shell echoes it) ────
  const SENTINEL = 'conduit_dnd_zzz';
  const dropPath = `C:\\tmp\\${SENTINEL}.txt`;
  await page.evaluate(
    ({ mime, p }) => {
      window.__cap = '';
      const term = document.querySelector('.termpane');
      const dt = new DataTransfer();
      dt.setData(mime, p);
      term.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      term.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    },
    { mime: MIME, p: dropPath },
  );

  const echoed = await page
    .waitForFunction((s) => (window.__cap || '').includes(s), SENTINEL, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  assert(echoed, 'dropped path should be pasted into the terminal (echoed by the shell)');
  log('dropping a file on the terminal inserts its path ✓');
});
