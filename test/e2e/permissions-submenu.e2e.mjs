import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-submenu');
const { env } = isolatedHome(userDataDir);
const work = join(userDataDir, 'work');
mkdirSync(work);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { conduitMcp: true, restoreSessions: true } }),
);

await runScenario(
  'permissions-submenu',
  async ({ page, log }) => {
    await tapMcp(page);
    const session = await openFake(page, work);
    assert(
      await until(
        async () => (await mcpState(page))?.policy.sessions[session.sessionId] !== undefined,
        10_000,
      ),
      'session has no permission projection',
    );
    const row = page.locator(`.session[data-sessionid="${session.sessionId}"]`);
    const permissions = page.getByRole('menuitem', { name: /^Permissions/ });
    const customize = page.getByRole('menuitem', { name: 'Customize…' });
    const openAt = async (x, y) => {
      await page.mouse.click(x, y, { button: 'right' });
      await permissions.waitFor();
      const box = await permissions.boundingBox();
      assert(box, 'Permissions row has no box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await customize.waitFor({ timeout: 3_000 });
      assert(await permissions.isVisible(), 'opening the submenu closed the parent');
      assert(
        (await permissions.getAttribute('aria-expanded')) === 'true',
        'submenu is not expanded',
      );
      const child = await page.getByRole('menu', { name: /^Permissions/ }).boundingBox();
      assert(child, 'submenu has no box');
      return { box, child };
    };

    await row.scrollIntoViewIfNeeded();
    const rowBox = await row.boundingBox();
    assert(rowBox, 'sidebar agent row has no box');
    const y = rowBox.y + rowBox.height / 2;
    const right = await openAt(rowBox.x + 4, y);
    assert(right.child.x >= right.box.x + right.box.width, 'submenu did not open to the right');

    const target = await customize.boundingBox();
    assert(target, 'Customize has no box');
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
    assert(await customize.isVisible(), 'moving diagonally into the submenu closed it');

    await page.keyboard.press('ArrowLeft');
    await customize.waitFor({ state: 'hidden' });
    assert(await permissions.isVisible(), 'ArrowLeft closed the parent');
    await page.keyboard.press('ArrowRight');
    await customize.waitFor();
    await page.keyboard.press('Escape');
    await customize.waitFor({ state: 'hidden' });
    assert(await permissions.isVisible(), 'Escape closed the parent');
    await page.keyboard.press('Enter');
    await customize.waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await permissions.waitFor({ state: 'hidden' });

    const parent = page.getByRole('menu').filter({ has: permissions });
    await page.mouse.click(rowBox.x + 4, y, { button: 'right' });
    const parentBox = await parent.boundingBox();
    assert(parentBox, 'parent menu has no box');
    await page.keyboard.press('Escape');
    const edgeX = rowBox.x + rowBox.width - 4;
    const height = await page.evaluate(() => innerHeight);
    await page.setViewportSize({ width: Math.ceil(edgeX + parentBox.width + 12), height });
    // Chromium delivers resize before the next frame; an open Popover dismisses on that event.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const left = await openAt(edgeX, y);
    assert(left.child.x + left.child.width <= left.box.x, 'submenu did not flip to the left');
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const fits = ({ x, y, width, height }) =>
      x >= 0 && y >= 0 && x + width <= viewport.width && y + height <= viewport.height;
    assert(fits(left.child), 'submenu crossed the viewport boundary');
    log('hover, diagonal movement, arrow keys and Escape preserve the parent menu');
  },
  { userDataDir, env },
);
