/**
 * CON-71 — the MCP › Agents drawer as a side panel (canvas D5, E1):
 *   1. Right-click an agent → Permissions ▸ → a role opens the workspace drawer at Review.
 *      Confirm writes the role. The header link takes the user to the same agent in Settings.
 *   2. A real wheel over the drawer scrolls only the drawer body: the list, the MCP panel and the
 *      drawer header stay where they were.
 *   3. Esc steps back one level at a time: drawer → closed → Settings closed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openAgentDrawerFromRow,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-drawer');
const { env } = isolatedHome(userDataDir);
const work = join(userDataDir, 'work');
mkdirSync(work);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({
    version: 1,
    settings: { conduitMcp: true, restoreSessions: true, lastSeenVersion: '0.0.0' },
  }),
);

const scrollTops = (page) =>
  page.evaluate(() => {
    const top = (selector) => document.querySelector(selector)?.scrollTop ?? null;
    return {
      list: top('.permissions-agents-list'),
      panel: top('.mcp-section__panel'),
      body: top('.permissions-drawer__body'),
      headTop: document.querySelector('.permissions-drawer__head')?.getBoundingClientRect().top,
    };
  });

await runScenario(
  'permissions-drawer',
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
    const name = (await row.locator('.session__name').first().textContent())?.trim() ?? '';

    await row.click({ button: 'right' });
    const permissions = page.locator('.ctxmenu__item', { hasText: /^Permissions/ });
    await permissions.waitFor();
    await permissions.click();
    const lead = page.getByRole('menuitemradio', { name: 'Lead', exact: true });
    await lead.waitFor();
    await lead.click();

    const settings = page.locator('.settings-page');
    const workspaceDrawer = page.locator(
      '.workspace-permissions__content aside.permissions-drawer',
    );
    await workspaceDrawer.waitFor();
    assert(!(await settings.isVisible()), 'choosing a role opened Settings');
    assert(
      (await page.getByRole('dialog', { name: /^Permissions · / }).count()) === 0,
      'Permissions opened the centered dialog',
    );
    const title = (
      await workspaceDrawer.locator('.permissions-drawer__title').textContent()
    )?.trim();
    assert(!name || title === name, `drawer opened for "${title}", not "${name}"`);
    const confirm = workspaceDrawer.getByRole('button', { name: 'Confirm and save' });
    await confirm.waitFor();
    log('row menu → Permissions ▸ Lead landed on the agent drawer at Review');

    // The footer the action lives in is pinned; nothing floating may cover it (CON-57 decision 6).
    const covered = await confirm.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(hit && node.contains(hit));
    });
    assert(!covered, 'something covers the drawer footer action');
    await confirm.click();
    const policyFile = join(userDataDir, 'conduit-mcp', 'policy.json');
    assert(
      await until(
        async () =>
          JSON.parse(readFileSync(policyFile, 'utf8')).assignments.some(
            ({ point, assignment }) =>
              point.kind === 'session' &&
              point.sessionId === session.sessionId &&
              assignment.profileId === 'lead',
          ),
        10_000,
      ),
      'the staged Lead role was not written after Confirm',
    );

    await workspaceDrawer.waitFor({ state: 'hidden' });
    const reopened = await openAgentDrawerFromRow(page, session.sessionId);
    await reopened.getByRole('button', { name: 'Open in MCP › Agents' }).click();
    const drawer = settings.locator('aside.permissions-drawer');
    await drawer.waitFor();
    assert(
      (await settings
        .getByRole('tab', { name: 'Agents', exact: true })
        .getAttribute('aria-selected')) === 'true',
      'the drawer link did not select MCP › Agents',
    );

    const toast = page.locator('[data-post-update-toast]');
    await toast.waitFor();
    const [toastBox, drawerBox] = await Promise.all([toast.boundingBox(), drawer.boundingBox()]);
    assert(
      toastBox && drawerBox && toastBox.x + toastBox.width <= drawerBox.x,
      'post-update toast overlaps the Settings permissions drawer',
    );

    // Give the drawer body more than it can show, then wheel over it.
    const groups = drawer.locator('.permissions-drawer__group > summary');
    await groups.first().waitFor();
    for (let i = 0; i < (await groups.count()); i++) await groups.nth(i).click();
    const before = await scrollTops(page);
    const box = await drawer.locator('.permissions-drawer__body').boundingBox();
    assert(box, 'drawer body has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);
    assert(
      await until(async () => ((await scrollTops(page)).body ?? 0) > (before.body ?? 0), 5_000),
      'the wheel did not scroll the drawer body',
    );
    const after = await scrollTops(page);
    assert(after.list === before.list, `the list moved: ${before.list} → ${after.list}`);
    assert(after.panel === before.panel, `the MCP panel moved: ${before.panel} → ${after.panel}`);
    assert(
      after.headTop === before.headTop,
      `the drawer header moved: ${before.headTop} → ${after.headTop}`,
    );
    log(`wheel scrolled only the drawer body (${before.body} → ${after.body})`);

    await drawer.locator('.permissions-drawer__body').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    assert(await settings.isVisible(), 'Esc closed Settings before the drawer');
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'hidden' });
    log('Esc ladder: drawer, then Settings');
  },
  { userDataDir, env, openFolder: false },
);
