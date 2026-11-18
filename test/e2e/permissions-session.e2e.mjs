import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-session');
const { env } = isolatedHome(userDataDir);
const work = join(userDataDir, 'work');
mkdirSync(work);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { conduitMcp: true, restoreSessions: true } }),
);

async function capture(page, name) {
  const dir = process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name) });
}

await runScenario(
  'permissions-session',
  async ({ page, log }) => {
    await tapMcp(page);
    const session = await openFake(page, work);
    const row = page.locator(`.session[data-sessionid="${session.sessionId}"]`);
    const dialog = page.getByRole('dialog', { name: /^Permissions · / });
    const menu = page.locator('.ctxmenu__item', { hasText: 'Permissions…' });

    assert(
      await until(
        async () => (await mcpState(page))?.policy.sessions[session.sessionId] !== undefined,
        10_000,
      ),
      'session has no permission projection',
    );
    await row.click({ button: 'right' });
    try {
      await menu.waitFor({ timeout: 5_000 });
    } catch (error) {
      log(`opened menu: ${(await page.locator('.ctxmenu__item').allTextContents()).join(' | ')}`);
      await capture(page, '01-session-menu-failed.png');
      throw error;
    }
    await capture(page, '01-session-menu.png');
    await menu.click();
    await dialog.waitFor();
    assert((await dialog.getAttribute('aria-modal')) === 'true', 'Permissions is not modal');
    assert(
      await dialog.evaluate((node) => node.contains(node.ownerDocument.activeElement)),
      'focus did not enter the Permissions dialog',
    );

    await dialog.getByRole('radio', { name: 'Lead', exact: true }).check();
    const review = dialog.getByRole('button', { name: 'Review changes' });
    await review.focus();
    await page.keyboard.press('Enter');
    const back = dialog.getByRole('button', { name: 'Back', exact: true });
    await back.waitFor();
    assert(
      await back.evaluate((node) => node === node.ownerDocument.activeElement),
      'keyboard review lost focus',
    );
    await capture(page, '02-permissions-review.png');
    await page.keyboard.press('Escape');
    await review.waitFor();
    assert(
      await review.evaluate((node) => node === node.ownerDocument.activeElement),
      'returning from review lost focus',
    );
    await review.click();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });

    const readPolicy = () =>
      JSON.parse(readFileSync(join(userDataDir, 'conduit-mcp', 'policy.json'), 'utf8'));
    assert(
      await until(
        async () =>
          readPolicy().assignments.some(
            ({ point, assignment }) =>
              point.kind === 'session' &&
              point.sessionId === session.sessionId &&
              assignment.profileId === 'lead',
          ),
        10_000,
      ),
      'the Lead assignment was not durably written',
    );
    assert(
      await until(
        async () =>
          /^Lead\b/.test((await mcpState(page))?.policy.sessions[session.sessionId]?.label ?? ''),
        10_000,
      ),
      'the session projection does not show the Lead profile',
    );
    await capture(page, '03-lead-applied.png');
    await row.click({ button: 'right' });
    await menu.click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    assert(!(await callTool(page, session.sessionId, 'list_sessions', {}))?.error, 'list_sessions');
    assert(
      await until(
        async () =>
          (await mcpState(page))?.policy.sessions[session.sessionId]?.profileId === 'lead',
        10_000,
      ),
      'owner policy did not retain the saved profile',
    );
    await row.click({ button: 'right' });
    await menu.click();
    await dialog.getByRole('button', { name: 'View Activity' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const activity = page.getByRole('main', { name: 'Permissions Activity' });
    await activity.waitFor();
    await activity.getByText('list_sessions', { exact: true }).first().waitFor();
    await capture(page, '11-session-activity.png');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.locator('.settings');
    await settings.getByRole('button', { name: 'MCP', exact: true }).click();
    await settings.getByRole('switch').first().waitFor();
    await settings.getByRole('button', { name: 'Open Permissions', exact: true }).click();
    const profiles = settings.getByRole('tab', { name: 'Profiles', exact: true });
    await profiles.waitFor();
    const copy = settings.getByRole('button', { name: 'Copy Worker' });
    await copy.waitFor();
    await capture(page, '13-settings-profiles.png');
    await copy.click();
    await settings.getByLabel('Name', { exact: true }).fill('Review workspace');
    await capture(page, '24-settings-profile-editor.png');
    await settings
      .getByRole('combobox', { name: 'Codex', exact: true })
      .selectOption('workspace-write');
    await settings.getByRole('button', { name: 'Review and save' }).click();
    await settings.getByRole('heading', { name: 'Review profile changes' }).waitFor();
    await settings.getByRole('row', { name: /Codex.*workspace-write/ }).waitFor();
    await settings.getByRole('button', { name: 'Confirm and save' }).click();
    await settings.getByRole('button', { name: 'Edit Review workspace' }).waitFor();
    const savedPolicy = JSON.parse(readFileSync(join(userDataDir, 'conduit-mcp', 'policy.json')));
    assert(
      savedPolicy.profiles.some(
        (profile) =>
          profile.name === 'Review workspace' && profile.nativeModes?.codex === 'workspace-write',
      ),
      'the exact reviewed native profile was not persisted',
    );
    await settings.getByRole('button', { name: 'Delete Review workspace' }).click();
    await settings.getByRole('button', { name: 'Review deletion' }).click();
    await settings.getByRole('button', { name: 'Confirm deletion' }).click();
    // The deletion editor hides the profile list before the host acknowledges deletion.
    await settings.getByRole('heading', { name: 'Profiles', exact: true }).waitFor();
    await settings
      .getByRole('button', { name: 'Edit Review workspace' })
      .waitFor({ state: 'hidden' });
    const afterDeletion = JSON.parse(readFileSync(join(userDataDir, 'conduit-mcp', 'policy.json')));
    assert(
      !afterDeletion.profiles.some((profile) => profile.name === 'Review workspace'),
      'profile deletion did not persist',
    );
    await profiles.focus();
    await page.keyboard.press('ArrowRight');
    const assignments = settings.getByRole('tab', { name: 'Assignments' });
    assert(
      (await assignments.getAttribute('aria-selected')) === 'true',
      'keyboard did not select the Assignments tab',
    );
    await settings.getByRole('heading', { name: 'Who gets which profile' }).waitFor();
    await capture(page, '14-settings-assignments.png');
    await page.keyboard.press('End');
    await settings.getByText('No grants yet.').waitFor();
    await capture(page, '07-settings-grants.png');
    await settings.getByRole('button', { name: 'Activity', exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    await activity.waitFor();
    log('owner modal, keyboard tabs, durable exact native profile and scoped Activity verified');
  },
  { userDataDir, env, openFolder: false },
);
