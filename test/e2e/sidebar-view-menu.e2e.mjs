/**
 * sidebar-view-menu — the ⋯ view menu on the Agents panel (CON-159).
 *   - three sessions of different kinds (a Claude-kind and a Codex-kind agent that keep running,
 *     and an agent of no named kind that exits): the defaults group them by status;
 *   - Group: By agent type regroups them under Claude / Codex / Other headers;
 *   - Running only, picked with the keyboard (Space on the focused row), drops the exited one;
 *   - Escape closes the menu and returns focus to ⋯, which carries a dot while options differ;
 *   - after a relaunch the choices are still checked and the dot is still there;
 *   - Reset restores By status and clears the dot.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import {
  assert,
  closeApp,
  launchApp,
  openSession,
  phase,
  probeProfile,
  removeDir,
  runScenario,
  shutdownApp,
  tapBridge,
} from './harness.mjs';
import { groupOf, rowIds, treeItems, waitFact } from './sidebar-tree-helpers.mjs';

// The agent's kind comes from its id's tokens (src/agent-icon.ts), so the same long-lived program
// plays Claude and Codex.
const LONG_LIVED = ['-e', 'setInterval(() => {}, 1e6)'];
const agent = (id, label, args) => ({
  id,
  label,
  command: process.execPath,
  args,
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});
const CLAUDE = 'e2e-claude';
const CODEX = 'e2e-codex';
const GONE = 'e2e-gone';
const probe = probeProfile('sidebar-view-menu', [
  agent(CLAUDE, 'Claude-like', LONG_LIVED),
  agent(CODEX, 'Codex-like', LONG_LIVED),
  agent(GONE, 'Exits', ['-e', "process.stdout.write('bye\\r\\n')"]),
]);

const trigger = (page) => page.getByRole('button', { name: /^Agents view options/ });
const choice = (page, role, name) => page.getByRole(role, { name });
const checked = (loc) => loc.getAttribute('aria-checked');
const groupKeys = async (page) =>
  (await treeItems(page)).filter((i) => i.kind === 'group').map((i) => i.key);

async function openMenu(page) {
  await trigger(page).click();
  await page.getByRole('menu', { name: 'Agents view options' }).waitFor({ timeout: 5_000 });
}

async function menuState(page) {
  return {
    sort: await checked(choice(page, 'menuitemradio', 'Recent activity')),
    status: await checked(choice(page, 'menuitemradio', 'By status')),
    type: await checked(choice(page, 'menuitemradio', 'By agent type')),
    running: await checked(choice(page, 'menuitemcheckbox', /^Running only/)),
  };
}

await runScenario(
  'sidebar-view-menu',
  async ({ app, page, userDataDir, log }) => {
    const dirs = ['claude', 'codex', 'gone'].map((n) =>
      mkdtempSync(join(tmpdir(), `conduit-viewmenu-${n}-`)),
    );
    await tapBridge(page);

    phase('three kinds of agent');
    const a = await openSession(page, { path: dirs[0], agentId: CLAUDE });
    const b = await openSession(page, { path: dirs[1], agentId: CODEX });
    const c = await openSession(page, { path: dirs[2], agentId: GONE });
    assert(
      await until(
        async () =>
          (await page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id), c))
            ?.status === 'exited',
        20_000,
      ),
      'the exiting agent never showed exited',
    );
    // The Stopped group is folded by default, so the exited agent has a header and no row yet.
    await waitFact(
      () => groupKeys(page),
      (keys) => keys.includes('stopped'),
      'the exited agent counts under Stopped',
    );
    assert((await groupOf(page, a)) === 'idle', 'a running agent starts under a status group');
    assert((await groupOf(page, b)) === 'idle', 'the second running agent too');
    assert((await page.locator('.viewmenu__dot').count()) === 0, 'no dot at the defaults');
    log('defaults group by status, no dot ✓');

    phase('Group: By agent type');
    await openMenu(page);
    const state0 = await menuState(page);
    assert(
      state0.sort === 'true' && state0.status === 'true' && state0.type === 'false',
      `defaults are Recent activity / By status: ${JSON.stringify(state0)}`,
    );
    await choice(page, 'menuitemradio', 'By agent type').click();
    await waitFact(
      () => groupOf(page, a),
      (g) => g === 'type:claude',
      'the Claude-kind agent groups under Claude',
    );
    assert((await groupOf(page, b)) === 'type:codex', 'the Codex-kind agent groups under Codex');
    assert((await groupOf(page, c)) === 'type:other', 'an unnamed kind groups under Other');
    assert(
      (await page.getByRole('menu', { name: 'Agents view options' }).count()) === 1,
      'picking leaves the menu open',
    );
    log('grouped by agent type ✓');

    phase('Filter: Running only, by keyboard');
    const running = choice(page, 'menuitemcheckbox', /^Running only/);
    await running.focus();
    await page.keyboard.press('Space');
    await waitFact(
      () => checked(running),
      (v) => v === 'true',
      'Space toggles Running only',
    );
    await waitFact(
      () => rowIds(page),
      (ids) => ids.includes(a) && ids.includes(b) && !ids.includes(c),
      'Running only drops the exited agent',
    );
    assert((await groupOf(page, a)) === 'type:claude', 'the rest stay grouped by type');
    log('Running only applied ✓');

    phase('Escape returns focus, dot shows');
    await page.keyboard.press('Escape');
    await page.getByRole('menu', { name: 'Agents view options' }).waitFor({ state: 'detached' });
    assert(
      await page.evaluate(() =>
        (document.activeElement?.getAttribute('aria-label') ?? '').startsWith(
          'Agents view options',
        ),
      ),
      'focus returns to the ⋯ button',
    );
    assert(
      (await page.locator('.viewmenu__dot').count()) === 1,
      'the dot marks non-default options',
    );

    phase('relaunch: the choices persist');
    await closeApp(app, page);
    let second = null;
    try {
      second = await launchApp({ userDataDir, openFolder: false });
      const p2 = second.page;
      await tapBridge(p2);
      await p2.locator('.viewmenu__dot').waitFor({ state: 'attached', timeout: 20_000 });
      await openMenu(p2);
      const restored = await menuState(p2);
      assert(
        restored.type === 'true' && restored.running === 'true' && restored.status === 'false',
        `the choices came back: ${JSON.stringify(restored)}`,
      );
      log('By agent type + Running only restored ✓');

      phase('Reset');
      await p2.getByRole('menuitem', { name: 'Reset' }).click();
      await waitFact(
        () => menuState(p2),
        (s) => s.status === 'true' && s.type === 'false' && s.running === 'false',
        'Reset restores the defaults',
      );
      assert((await p2.locator('.viewmenu__dot').count()) === 0, 'the dot goes with the changes');
      assert(
        (await groupKeys(p2)).every((k) => !k.startsWith('type:')),
        'the tree is grouped by status again',
      );
      await p2.keyboard.press('Escape');
      log('Reset restored the default view ✓');
    } finally {
      if (second) await shutdownApp(second.app, second.page);
      for (const d of dirs) await removeDir(d, { budgetMs: 10_000 });
    }
  },
  { userDataDir: probe.userDataDir },
);
