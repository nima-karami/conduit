/**
 * Editor navigation history, cursor-move flows (docs/specs/2026-09-22-editor-nav-history.md §7):
 * AC2 a same-file big jump is an entry, AC5 small moves coalesce, AC6 arrow keys never record,
 * AC12 rapid presses apply one at a time. Each case uses its own files so an earlier case's
 * entries cannot satisfy a later assertion.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs editor-nav-history-moves`.
 */

import { assert, openSession, runScenario } from './harness.mjs';
import {
  activeTab,
  clickLine,
  cursorLine,
  lineVisible,
  makeNavFixture,
  openViaTree,
  waitActive,
  waitCursor,
} from './nav-history-fixture.mjs';

runScenario('editor-nav-history-moves', async ({ page, log }) => {
  const root = makeNavFixture([
    'm2x.ts',
    'm2a.ts',
    'm5x.ts',
    'm5a.ts',
    'm6x.ts',
    'm6a.ts',
    'm12x.ts',
    'm12a.ts',
    'm12b.ts',
    'm12c.ts',
  ]);
  await openSession(page, { path: root });

  const open = async (name) => {
    await openViaTree(page, root, [name]);
    assert(await waitActive(page, name), `${name} should be active after a tree open`);
    await page.waitForFunction(() => (window.monaco?.editor.getEditors() ?? []).length > 0, null, {
      timeout: 15000,
    });
  };
  const expectActive = async (title, what) =>
    assert(
      await waitActive(page, title),
      `${what}: expected ${title}, got ${await activeTab(page)}`,
    );

  // AC2
  await open('m2x.ts');
  await open('m2a.ts');
  await clickLine(page, 5);
  assert(
    await waitCursor(page, 5),
    `AC2: click should put the cursor on 5, got ${await cursorLine(page)}`,
  );
  await page.keyboard.press('Control+End');
  await page.waitForFunction(
    () => {
      const eds = window.monaco?.editor.getEditors() ?? [];
      return (eds.find((e) => e.hasTextFocus())?.getPosition()?.lineNumber ?? 0) >= 120;
    },
    null,
    { timeout: 5000 },
  );
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('m2a.ts', 'AC2 first Back');
  assert(await waitCursor(page, 5), `AC2: Back lands on m2a.ts:5, got ${await cursorLine(page)}`);
  assert(await lineVisible(page, 5), 'AC2: line 5 visible after Back');
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('m2x.ts', 'AC2 second Back');
  log('AC2 same-file big jump is an entry ✓');

  // AC5
  await open('m5x.ts');
  await open('m5a.ts');
  for (const line of [8, 14, 20]) {
    await clickLine(page, line);
    assert(await waitCursor(page, line), `AC5: click to ${line}, got ${await cursorLine(page)}`);
  }
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('m5x.ts', 'AC5 Back');
  await page.keyboard.press('Alt+ArrowRight');
  await expectActive('m5a.ts', 'AC5 Forward');
  assert(
    await waitCursor(page, 20),
    `AC5: Forward returns to m5a.ts:20, got ${await cursorLine(page)}`,
  );
  log('AC5 small moves coalesce ✓');

  // AC6
  await open('m6x.ts');
  await open('m6a.ts');
  await clickLine(page, 1);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  assert(await waitCursor(page, 31), `AC6: 30 arrows reach line 31, got ${await cursorLine(page)}`);
  await page.keyboard.press('Alt+ArrowLeft');
  await expectActive('m6x.ts', 'AC6 Back');
  log('AC6 arrows do not record ✓');

  // AC12
  for (const name of ['m12x.ts', 'm12a.ts', 'm12b.ts', 'm12c.ts']) await open(name);
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });
  await expectActive('m12x.ts', 'AC12 three rapid Backs');
  await page.keyboard.press('Alt+ArrowRight');
  await expectActive('m12a.ts', 'AC12 Forward after rapid Backs');
  log('AC12 rapid presses land one entry each ✓');
});
