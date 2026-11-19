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

const userDataDir = fakeAgentProfile('workspace-permissions');
const { env } = isolatedHome(userDataDir);
const work = join(userDataDir, 'work');
mkdirSync(work);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { conduitMcp: true, restoreSessions: true } }),
);

await runScenario(
  'workspace-permissions',
  async ({ page, log }) => {
    await tapMcp(page);
    const { sessionId } = await openFake(page, work);
    assert(
      await until(
        async () => (await mcpState(page))?.policy.sessions[sessionId] !== undefined,
        10_000,
      ),
      'session has no permission projection',
    );
    const row = page.locator(`.session[data-sessionid="${sessionId}"]`);
    await row.locator('.session__select').click();
    const terminal = page.locator('.workbench .xterm-screen:visible').first();
    await terminal.waitFor();
    const before = await terminal.boundingBox();
    assert(before, 'terminal did not render');

    const toast = page.locator('.toast').filter({ hasText: /Updated to v/ });
    await toast.waitFor();
    const toastBefore = await toast.boundingBox();
    assert(toastBefore, 'update toast has no box');

    await row.click({ button: 'right' });
    const permissions = page.getByRole('menuitem', { name: /^Permissions/ });
    await permissions.hover();
    await page.getByRole('menuitem', { name: 'Customize…', exact: true }).click();

    const panel = page.locator('.workspace-permissions__content');
    const drawer = panel.locator('aside.permissions-drawer');
    const settings = page.locator('.settings-page');
    await drawer.waitFor();
    const [box, workspace] = await Promise.all([
      panel.boundingBox(),
      page.locator('.workbench').boundingBox(),
    ]);
    assert(box && workspace, 'workspace drawer has no box');
    assert(Math.abs(box.width - 460) < 2, 'drawer width does not match the E2 design');
    assert(
      Math.abs(box.x + box.width - (workspace.x + workspace.width)) < 2 &&
        Math.abs(box.y - workspace.y) < 2,
      'drawer is not aligned to the top and right of the workspace',
    );
    const toastBeside = await toast.boundingBox();
    assert(
      toastBeside && toastBeside.x + toastBeside.width <= box.x,
      'update toast overlaps the workspace permissions drawer',
    );
    assert(!(await settings.isVisible()), 'Customize opened full-screen Settings');
    const after = await terminal.boundingBox();
    assert(
      after && after.x === before.x && after.width === before.width && after.x < box.x,
      'opening the drawer resized or obscured the terminal',
    );
    assert(
      await terminal.evaluate((screen, x) => {
        const r = screen.getBoundingClientRect();
        return screen.contains(
          document.elementFromPoint((r.left + Math.min(r.right, x)) / 2, r.top + r.height / 2),
        );
      }, box.x),
      'the terminal cannot be reached beside the drawer',
    );

    const evidence = process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, 'workspace-permissions.png') });
    }

    const activity = await drawer
      .getByRole('button', { name: 'View Activity', exact: true })
      .boundingBox();
    assert(activity && activity.width < box.width / 2, 'View Activity stretches across the drawer');
    const advanced = drawer.getByText('Advanced settings', { exact: true });
    assert(
      await advanced.evaluate((summary) => !summary.closest('details').open),
      'Advanced settings is expanded by default',
    );

    const review = drawer.getByRole('button', { name: 'Review', exact: true });
    assert(await review.isDisabled(), 'Review is enabled with no staged change');
    await drawer.getByRole('button', { name: 'Add a change', exact: true }).click();
    const add = drawer.getByRole('group', { name: 'Add a change' });
    await add.getByLabel('Tool', { exact: true }).selectOption('open_file');
    await add.getByText('Deny', { exact: true }).click();
    assert(
      await add.getByRole('radio', { name: 'Deny', exact: true }).isChecked(),
      'Deny did not select',
    );
    await add.getByRole('button', { name: 'Add change', exact: true }).click();
    assert(await review.isEnabled(), 'adding a change did not stage it for review');
    assert(
      !(await mcpState(page))?.policy.assignments.some(
        ({ point }) => point.kind === 'session' && point.sessionId === sessionId,
      ),
      'an unreviewed change was written',
    );

    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    const toastAfter = await toast.boundingBox();
    assert(
      toastAfter && Math.abs(toastAfter.x - toastBefore.x) < 2,
      'update toast did not return to its original horizontal position',
    );
    assert(
      await row.evaluate((node) => node === document.activeElement),
      'Escape did not return focus to the agent row',
    );
    assert(await terminal.isVisible(), 'the terminal disappeared after closing the drawer');
    log(
      'Customize opened a docked drawer over the workspace, staged an inline change, and returned focus on Escape',
    );
  },
  { userDataDir, env },
);
