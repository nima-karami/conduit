import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeAgentProfile, isolatedHome, openFake, tapMcp } from './conduit-mcp-helpers.mjs';
import { assert, openSession, pollUntil, probeTerminalSize, runScenario } from './harness.mjs';

const userDataDir = fakeAgentProfile('session-bar');
const { env } = isolatedHome(userDataDir);
const agentWork = join(userDataDir, 'agent-work');
const shellWork = join(userDataDir, 'shell-work');
mkdirSync(agentWork);
mkdirSync(shellWork);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({
    version: 1,
    settings: { conduitMcp: true, restoreSessions: true, lastSeenVersion: '0.71.0' },
  }),
);

async function positionedBar(pane) {
  const bar = pane.locator('.session-bar');
  await bar.waitFor();
  const geometry = await pane.evaluate((el) => {
    const frame = el.getBoundingClientRect();
    const strip = el.querySelector('.session-bar').getBoundingClientRect();
    const terminal = el.querySelector('.termpane').getBoundingClientRect();
    return {
      left: strip.left - frame.left - el.clientLeft,
      top: strip.top - frame.top - el.clientTop,
      width: strip.width - el.clientWidth,
      gap: terminal.top - strip.bottom,
    };
  });
  assert(
    geometry.left === 0 && geometry.top === 0 && Math.abs(geometry.width) < 1,
    `session bar does not occupy the top edge of its pane: ${JSON.stringify(geometry)}`,
  );
  assert(geometry.gap >= 0, 'the bar overlaps the terminal');
  return bar;
}

await runScenario(
  'session-bar',
  async ({ page, log }) => {
    await tapMcp(page);
    await page.evaluate(() => {
      window.__terms = {};
    });
    const { sessionId, handle } = await openFake(page, agentWork);
    const bar = await positionedBar(page.locator(`.termhost[data-sessionid="${sessionId}"]`));
    const session = bar.getByRole('button', { name: `Session menu for ${handle}` });
    const role = bar.getByRole('button', { name: new RegExp(`^Permissions for ${handle}`) });
    const schedule = bar.locator('.session-bar__schedule');
    await role.waitFor();

    await page.mouse.move(0, 0);
    for (const button of [session, role, schedule]) {
      const background = (element) => getComputedStyle(element).backgroundColor;
      const rest = await button.evaluate(background);
      await button.hover();
      assert((await button.evaluate(background)) !== rest, 'hover did not change button fill');
    }

    await session.click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await role.click();
    const drawer = page.locator('.workspace-permissions__content aside.permissions-drawer');
    await drawer.waitFor();
    assert(!(await page.locator('.settings-page').isVisible()), 'role opened full-screen Settings');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });

    await page.evaluate(
      (id) =>
        window.agentDeck.post({
          type: 'timer:set',
          schedule: {
            sessionId: id,
            message:
              'Session bar test\nOnly the first line belongs in the menu header, even for long messages.',
            trigger: { kind: 'in', delayMs: 30 * 60_000 },
          },
        }),
      sessionId,
    );
    await bar.getByRole('button', { name: /^Timed message — in / }).waitFor();
    await schedule.click();
    const menu = page.getByRole('menu', { name: /Message at .*Session bar test/ });
    await menu.getByRole('menuitem', { name: 'Send now', exact: true }).waitFor();
    await menu.getByRole('menuitem', { name: 'Timed messages…', exact: true }).waitFor();
    await menu.getByRole('menuitem', { name: `Turn auto-resume off for ${handle}` }).click();
    await page.waitForFunction(
      (id) => window.__sessions.find((s) => s.id === id)?.autoResume === 'off',
      sessionId,
    );
    await schedule.click();
    await menu.getByRole('menuitem', { name: `Turn auto-resume on for ${handle}` }).click();
    await page.waitForFunction(
      (id) => window.__sessions.find((s) => s.id === id)?.autoResume === 'on',
      sessionId,
    );

    await session.click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    assert(await role.evaluate((el) => el === document.activeElement), 'Tab did not reach role');
    await page.keyboard.press('Enter');
    await drawer.waitFor();
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    await page.keyboard.press('Tab');
    assert(
      await schedule.evaluate((el) => el === document.activeElement),
      'Tab did not reach schedule',
    );
    await page.keyboard.press('Enter');
    await menu.waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await bar.getByRole('button', { name: 'Timed messages', exact: true }).waitFor();
    await schedule.click();
    await page.locator('.tmdlg').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.tmdlg').waitFor({ state: 'hidden' });
    log('Mouse and keyboard opened the menus and permissions, and Cancel removed the schedule');

    const evidence = process.env.CONDUIT_SESSION_BAR_EVIDENCE;
    for (const [id, label] of [
      ['aero-dark', 'Aero Dark'],
      ['aero', 'Aero'],
      ['neon', 'Neon'],
    ]) {
      await page.keyboard.press('Control+Shift+P');
      await page.locator('.palette__input').fill(`>Theme: ${label}`);
      await page.getByText(`Theme: ${label}`, { exact: true }).click();
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, id);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `${id}.png`), clip: await bar.boundingBox() });
      }
    }

    const shellId = await openSession(page, { path: shellWork });
    const shellPane = page.locator(`.termhost[data-sessionid="${shellId}"]`);
    const shellBar = await positionedBar(shellPane);
    const shellName = await page.evaluate(
      (id) => window.__sessions.find((s) => s.id === id).name,
      shellId,
    );
    assert(
      await shellBar.getByRole('button', { name: `Session menu for ${shellName}` }).isVisible(),
      'shell name is missing',
    );
    assert(
      (await shellBar.getByRole('button', { name: /^Permissions/ }).count()) === 0,
      'shell has a role',
    );
    const size = await probeTerminalSize(page, shellId, 'SESSION-BAR-GEOMETRY');
    assert(
      size.xterm === size.pty && size.screenH <= size.paneH,
      `terminal grid ${size.xterm} (${size.screenH}px) differs from PTY ${size.pty} in ${size.paneH}px`,
    );
    log(`Shell and PTY geometry verified at ${size.pty}`);

    await page.locator(`.session[data-sessionid="${sessionId}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in split pane', exact: true }).click();
    await positionedBar(shellPane);
    await positionedBar(page.locator(`.termhost[data-sessionid="${sessionId}"]`));
    await page.waitForFunction(({ id, cols }) => window.__terms[id]?.cols < cols, {
      id: shellId,
      cols: Number(size.xterm.split('x')[0]),
    });
    let splitSize;
    let probe = 0;
    assert(
      await pollUntil(async () => {
        splitSize = await probeTerminalSize(page, shellId, `SB-SPLIT-${++probe}`);
        return splitSize.pty === splitSize.xterm && splitSize.screenH <= splitSize.paneH;
      }, 5_000),
      `split grid and PTY differ: ${JSON.stringify(splitSize)}`,
    );
    log(`Split panes and PTY geometry verified at ${splitSize.pty}`);
  },
  { env, userDataDir },
);
