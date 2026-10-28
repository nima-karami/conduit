/**
 * conduit-mcp-install-banner — a typed agent CLI that never reaches Conduit is detected and the
 * setup banner offered (spec docs/specs/2026-10-27-conduit-mcp-install.md §2.5, AC11, AC12; plan
 * T5.3). `claude` on PATH is a stub that only echoes, so no real Claude ever runs; the grace is
 * 1.5 s under CONDUIT_E2E_DETECT_GRACE_MS. Every config file lives in an isolated home.
 *   1. `claude` typed in a shell → notConnected {cli: claude}; the card shows the unplug with the
 *      install hint; the banner offers Install for Claude Code.
 *   2. `claude --version` in another shell is on the skip list: no notConnected.
 *   3. The palette's Set up Conduit MCP… opens Settings on the MCP tab.
 *   4. Don't suggest again hides the banner and persists the dismissal.
 *   5. Another shell typing `claude` is still detected, but gets no banner.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedHome, mcpState, pathWith, sleep, tapMcp, until } from './conduit-mcp-helpers.mjs';
import { assert, openSession, profileDir, runScenario, typeLine } from './harness.mjs';

const userDataDir = profileDir('mcp-install-banner');
const { homeDir, env: homeEnv } = isolatedHome(userDataDir);
const binDir = join(userDataDir, 'bin');
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, 'claude.cmd'), '@echo stub-claude\r\n');
const work = join(userDataDir, 'work');
mkdirSync(work, { recursive: true });
const DETECT_WITHIN_MS = 15_000;

await runScenario(
  'conduit-mcp-install-banner',
  async ({ page, log }) => {
    writeFileSync(join(homeDir, '.claude.json'), '{}');
    await tapMcp(page);
    const notConnected = async (sid) => (await mcpState(page))?.notConnected?.[sid];
    const banner = page.getByRole('region', { name: 'Conduit setup' });

    // 1. detect
    const sid = await openSession(page, { path: work });
    await typeLine(page, sid, 'claude');
    const detected = await until(
      async () => (await notConnected(sid))?.cli === 'claude',
      DETECT_WITHIN_MS,
    );
    assert(detected, `notConnected: ${JSON.stringify((await mcpState(page))?.notConnected)}`);
    await page
      .locator(`.session[data-sessionid="${sid}"] .session__mcp-link`)
      .and(
        page.getByRole('img', {
          name: 'Not connected: install Conduit for Claude Code in Settings → MCP',
        }),
      )
      .waitFor({ timeout: 10_000 });
    await banner.waitFor({ timeout: 10_000 });
    await banner.getByRole('button', { name: 'Install for Claude Code' }).waitFor();
    log('claude typed → notConnected, unplug hint on the card, banner offers Install ✓');

    // 2. skip list
    const sidV = await openSession(page, { path: work });
    await typeLine(page, sidV, 'claude --version');
    await sleep(3_000);
    assert(
      (await notConnected(sidV)) === undefined,
      'claude --version is non-interactive: no notConnected',
    );
    log('claude --version is not detected ✓');

    // 3. palette → MCP tab (from the first shell, whose banner is the one under test)
    await page.locator(`.session[data-sessionid="${sid}"]`).click();
    await banner.waitFor({ timeout: 10_000 });
    await page.click('.omnibar');
    await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10_000 });
    await page.fill('.palette__input', '>Set up Conduit MCP');
    await page
      .locator('.palette__row', { hasText: 'Set up Conduit MCP' })
      .first()
      .waitFor({ timeout: 5_000 });
    await page.keyboard.press('Enter');
    await page
      .locator('.settings__navitem--active', { hasText: 'MCP' })
      .waitFor({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.locator('.modal.settings').waitFor({ state: 'detached', timeout: 5_000 });
    log('palette Set up Conduit MCP… opens the MCP tab ✓');

    // 4. dismiss
    await banner.getByRole('button', { name: 'Don’t suggest again' }).click();
    await banner.waitFor({ state: 'detached', timeout: 5_000 });
    const settingsFile = join(userDataDir, 'settings.json');
    const persisted = await until(() => {
      if (!existsSync(settingsFile)) return false;
      const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
      return s.settings?.mcpInstallPromptDismissed?.claude === true;
    }, 10_000);
    assert(persisted, 'mcpInstallPromptDismissed.claude persisted');
    log('Don’t suggest again hides the banner and persists ✓');

    // 5. a second shell: detected, no banner
    const sid2 = await openSession(page, { path: work });
    await typeLine(page, sid2, 'claude');
    const detected2 = await until(
      async () => (await notConnected(sid2))?.cli === 'claude',
      DETECT_WITHIN_MS,
    );
    assert(detected2, 'the second shell is still detected');
    await sleep(2_000);
    assert(!(await banner.isVisible()), 'no banner once dismissed');
    log('second shell detected, no banner ✓');
  },
  {
    userDataDir,
    env: { ...homeEnv, ...pathWith(binDir), CONDUIT_E2E_DETECT_GRACE_MS: '1500' },
  },
);
