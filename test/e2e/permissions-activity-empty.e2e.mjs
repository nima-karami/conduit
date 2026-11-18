import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fakeAgentProfile, isolatedHome } from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-activity-empty');
const { env } = isolatedHome(userDataDir);

async function capture(page, filename) {
  const directory = process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, filename) });
}

await runScenario(
  'permissions-activity-empty',
  async ({ page, log }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.locator('.settings-page');
    await settings.getByRole('button', { name: 'Permissions', exact: true }).click();
    await settings.getByRole('button', { name: 'Activity', exact: true }).click();
    const activity = page.getByRole('main', { name: 'Permissions Activity' });
    await activity.getByRole('heading', { name: 'Permissions Activity' }).waitFor();
    await activity.getByText('No activity found.', { exact: true }).waitFor();
    assert((await activity.getByRole('alert').count()) === 0, 'empty Activity showed an error');
    assert((await activity.getByRole('table').count()) === 0, 'empty Activity invented rows');
    assert(
      await activity.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(),
      'Refresh is unavailable',
    );
    assert(await activity.getByLabel('Session').isVisible(), 'Session filter is unavailable');
    assert(await activity.getByLabel('Decision').isVisible(), 'Decision filter is unavailable');
    await capture(page, '18-activity-empty.png');
    log('first-run empty state and accessible controls verified');

    // A directory at a retained day filename is a real unreadable day on every supported platform.
    const day = new Date().toISOString().slice(0, 10);
    mkdirSync(join(userDataDir, 'conduit-mcp', 'activity', `${day}.jsonl`), { recursive: true });
    await activity.getByRole('button', { name: 'Refresh', exact: true }).click();
    const alert = activity.getByRole('alert');
    await alert.waitFor();
    assert(
      /could not be read|unavailable/i.test(await alert.innerText()),
      'Activity did not explain the unreadable store',
    );
    assert(
      (await activity.getByText('No activity found.', { exact: true }).count()) === 0,
      'unreadable Activity was presented as empty',
    );
    assert((await activity.getByRole('table').count()) === 0, 'unreadable Activity invented rows');
    assert(
      (await activity.getByRole('button', { name: /allow.*once/i }).count()) === 0,
      'unreadable Activity exposed an authorization action',
    );
    assert(
      await activity.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(),
      'retry is unavailable',
    );
    await capture(page, '19-activity-unavailable.png');
    log('unreadable retained day is reported without inferring history');
  },
  { userDataDir, env },
);
