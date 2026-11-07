/**
 * sidebar-space-filter — the Spaces filter over the agent tree (spec
 * docs/specs/archive/2026-11-02-sidebar-agent-tree.md §3, §5, §6; plan "New exact scenario files").
 * Sessions run the fake MCP agent; the child is opened through the real MCP `open_session`, so
 * its `openedBy` and its inherited Space are the host's.
 *   - All / one Space / No space show exactly their members; the dim "· Space" detail and the
 *     ", Space" in a row's name appear only under All;
 *   - Search agents reveals the filter; Escape clears and hides it and returns focus to Search;
 *     a non-empty query stays visible on blur;
 *   - New agent defaults to the selected Space, and under All to the last focused agent's;
 *   - dragging a parent onto a Space moves only it (All is no target), and Move to space… does
 *     the same: the child keeps its Space;
 *   - a cross-Space child sits under its parent under All, and is a root, parent absent, under
 *     its own Space;
 *   - two windows: each gets its own Space selection back after a relaunch, and the folded row,
 *     the pin and the folded group come back too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAgentProfile, openFake, sessions, tapMcp, until } from './conduit-mcp-helpers.mjs';
import {
  assert,
  closeApp,
  createProject,
  launchApp,
  phase,
  removeDir,
  runScenario,
  selectSpace,
  shutdownApp,
  tapBridge,
} from './harness.mjs';
import {
  dragRowOntoSpace,
  exact,
  groupHeader,
  groupOf,
  killAll,
  moveViaPicker,
  nameOf,
  openChild,
  row,
  rowIds,
  sessionOf,
  spaceRow,
  treeItems,
  waitFact,
  waitRows,
} from './sidebar-tree-helpers.mjs';

const STATUS = '(Working|Needs you|Done|Idle|Stopped)';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "<name>, <status>" with nothing after it: no Space, no sub-agent note. */
const bare = (name) => new RegExp(`^${escapeRe(name)}, ${STATUS}$`);
/** "<name>, <status>, <space>": the Space is named, as only All does. */
const spaced = (name, space) => new RegExp(`^${escapeRe(name)}, ${STATUS}, ${escapeRe(space)}$`);

const labelOf = (page, id) => row(page, id).getAttribute('aria-label');
const spaceDetailOf = async (page, id) =>
  (
    await row(page, id)
      .locator('.session__space')
      .textContent({ timeout: 2_000 })
      .catch(() => null)
  )?.trim() ?? null;

/** A row's depth in the tree (its aria-level) and the row rendered right before it. */
async function placeOf(page, id) {
  const rows = (await treeItems(page)).filter((i) => i.kind === 'row');
  const i = rows.findIndex((r) => r.id === id);
  return i < 0 ? null : { level: rows[i].level, prev: rows[i - 1]?.id ?? null, item: rows[i] };
}

async function newAgentChip(page, chip, what) {
  await page.locator('.sidebar').getByRole('button', { name: 'New agent', exact: true }).click();
  await page
    .locator(chip)
    .waitFor({ state: 'visible', timeout: 8_000 })
    .catch(() => {
      assert(false, `${what}: the New agent dialog should open with ${chip}`);
    });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 5_000 });
}

async function selectRow(page, id) {
  await row(page, id).locator('[data-agent-action="select"]').click();
  await page.waitForSelector(`.session--active[data-sessionid="${id}"]`, { timeout: 5_000 });
}

/** A second window over `win:new`, as conduit-mcp-app-sessions opens one. */
async function newWindow(app, page) {
  const next = app.waitForEvent('window', { timeout: 20_000 });
  await page.evaluate(() => window.agentDeck.post({ type: 'win:new' }));
  const page2 = await next;
  await page2.waitForLoadState('domcontentloaded');
  await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20_000 });
  return page2;
}

const pressed = (page, key) => spaceRow(page, key).getAttribute('aria-pressed');

/** Bounded negative check: a later child-move message would show as the child leaving `space`. */
async function assertChildKeepsAlpha(page, id, space, what) {
  try {
    await page.waitForFunction(
      ([sid, sp]) => (window.__sessions || []).find((x) => x.id === sid)?.projectId !== sp,
      [id, space],
      { timeout: 800 },
    );
    assert(false, `${what}: the child left Alpha within the observation window`);
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
  }
  assert((await sessionOf(page, id))?.projectId === space, what);
}

/** Resolves once the app has `n` windows; the 'window' event is the signal, not a poll. */
async function waitWindows(app, n, timeout) {
  await new Promise((resolve) => {
    const done = () => {
      app.off('window', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (app.windows().length >= n) done();
    };
    const timer = setTimeout(done, timeout);
    app.on('window', check);
    check();
  });
}

runScenario(
  'sidebar-space-filter',
  async ({ app, page, userDataDir, log }) => {
    await tapMcp(page);
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-space-filter-${label}-`));
    const dirs = { p: temp('p'), c: temp('c'), l: temp('l'), w: temp('w') };

    phase('setup');
    await killAll(page);
    const alpha = await createProject(page, 'Alpha');
    const beta = await createProject(page, 'Beta');
    const gamma = await createProject(page, 'Gamma');
    const p = (await openFake(page, dirs.p, { projectId: alpha })).sessionId;
    const c = await openChild(page, p, { path: dirs.c, label: 'space-child' });
    const l = (await openFake(page, dirs.l)).sessionId;
    assert(
      (await sessionOf(page, c))?.projectId === alpha,
      'an MCP-opened child takes its opener’s Space',
    );
    const pName = await nameOf(page, p);
    const lName = await nameOf(page, l);
    log({ p, c, l, alpha, beta, gamma });

    phase('All / Space / No space');
    await selectSpace(page, 'all');
    await waitRows(page, [p, c, l], 'All shows every agent of this window');
    assert(spaced(pName, 'Alpha').test(await labelOf(page, p)), `All: P ${await labelOf(page, p)}`);
    assert(
      spaced('space-child', 'Alpha').test(await labelOf(page, c)),
      `All: a nested row names its Space too: ${await labelOf(page, c)}`,
    );
    assert(bare(lName).test(await labelOf(page, l)), `All: a loose row names no Space`);
    assert((await spaceDetailOf(page, p)) === '· Alpha', 'All: the root shows its dim Space');
    assert((await spaceDetailOf(page, l)) === null, 'All: a loose row shows no Space detail');
    assert(
      (await row(page, c).locator('.session__space').count()) === 0,
      'a nested row never repeats the Space detail',
    );
    await selectSpace(page, alpha);
    await waitRows(page, [p, c], 'Alpha shows its two members');
    assert(bare(pName).test(await labelOf(page, p)), `Alpha: P names no Space`);
    assert(bare('space-child').test(await labelOf(page, c)), `Alpha: C names no Space`);
    assert(
      (await page.locator('[data-agent-tree] .session__space').count()) === 0,
      'no Space detail under a single Space',
    );
    await selectSpace(page, 'no-space');
    await waitRows(page, [l], 'No space shows the loose agent only');
    assert(bare(lName).test(await labelOf(page, l)), 'No space: the label names no Space');
    await selectSpace(page, beta);
    await waitRows(page, [], 'an empty Space shows no rows');
    assert(
      (await page.locator('.sidebar .emptystate__title').textContent()) ===
        'No agents in this space',
      'an empty Space says so',
    );
    log('All / Alpha / No space / empty Beta filter exactly; Space named only under All ✓');

    phase('search reveal');
    await selectSpace(page, 'all');
    const search = page
      .locator('.sidebar')
      .getByRole('button', { name: 'Search agents', exact: true });
    const filter = page.locator('input.sessbar__filter');
    assert((await search.getAttribute('aria-expanded')) === 'false', 'Search starts collapsed');
    assert((await filter.count()) === 0, 'no filter input until Search');
    await search.click();
    await filter.waitFor({ state: 'visible', timeout: 5_000 });
    assert(
      await filter.evaluate((el) => document.activeElement === el),
      'the revealed filter takes focus',
    );
    assert((await search.getAttribute('aria-expanded')) === 'true', 'Search reads expanded');
    const controls = await search.getAttribute('aria-controls');
    assert(
      controls &&
        (await page.evaluate(
          (id) => !!document.getElementById(id)?.querySelector('input.sessbar__filter'),
          controls,
        )),
      `Search's aria-controls (${controls}) names the filter's container`,
    );
    assert((await filter.getAttribute('aria-label')) === 'Filter sessions', 'filter label');
    await filter.fill(lName);
    await waitRows(page, [l], 'the filter narrows to the matching agent');
    await page.keyboard.press('Escape');
    await filter.waitFor({ state: 'detached', timeout: 5_000 });
    assert(
      await search.evaluate((el) => document.activeElement === el),
      'Escape returns focus to Search agents',
    );
    assert((await search.getAttribute('aria-expanded')) === 'false', 'Search collapses');
    await waitRows(page, [p, c, l], 'Escape clears the query');
    await search.click();
    await filter.waitFor({ state: 'visible', timeout: 5_000 });
    await filter.fill(lName);
    await page.evaluate(() => document.activeElement?.blur());
    // Bounded negative check: blur must not collapse a non-empty query within the window.
    const collapsed = await page
      .waitForFunction(() => !document.querySelector('input.sessbar__filter'), null, {
        timeout: 400,
      })
      .then(() => true)
      .catch((error) => {
        if (error.name !== 'TimeoutError') throw error;
        return false;
      });
    assert(!collapsed, 'a non-empty query collapsed on blur');
    assert(await filter.isVisible(), 'a non-empty query stays visible on blur');
    await waitRows(page, [l], 'the blurred query keeps filtering');
    await filter.focus();
    await page.keyboard.press('Escape');
    await filter.waitFor({ state: 'detached', timeout: 5_000 });
    await waitRows(page, [p, c, l], 'cleared again');
    log('Search agents reveals, Escape clears + hides + refocuses Search ✓');

    phase('default Space for a new agent');
    await selectSpace(page, beta);
    await newAgentChip(page, 'button.ns-chip__body[aria-label="Space: Beta"]', 'Beta selected');
    await selectSpace(page, 'all');
    await selectRow(page, p);
    await newAgentChip(page, 'button.ns-chip__body[aria-label="Space: Alpha"]', 'All, P focused');
    await selectRow(page, l);
    await newAgentChip(page, '.ns-chip.ns-chip--none', 'All, the loose agent focused');
    assert((await pressed(page, 'all')) === 'true', 'opening New agent leaves the filter alone');
    log('New agent: selected Space, else the last focused agent’s (or none) ✓');

    phase('drag a parent onto a Space');
    const toAll = await dragRowOntoSpace(app, page, p, 'all');
    assert(!toAll.error, `drag setup: ${toAll.error}`);
    assert(!toAll.accepted && !toAll.cue, `All is never a drop target: ${JSON.stringify(toAll)}`);
    const toBeta = await dragRowOntoSpace(app, page, p, beta);
    assert(!toBeta.error, `drag setup: ${toBeta.error}`);
    assert(toBeta.accepted && toBeta.cue, `Beta accepts P with a cue: ${JSON.stringify(toBeta)}`);
    await waitFact(
      () => sessionOf(page, p),
      (s) => s?.projectId === beta,
      'the dropped parent moves to Beta',
    );
    await assertChildKeepsAlpha(page, c, alpha, 'its child keeps Alpha');
    assert((await sessionOf(page, l))?.projectId === undefined, 'the loose agent is untouched');
    log('drop on Beta moves P alone; All refuses the drop ✓');

    phase('cross-Space parent');
    await waitRows(page, [p, c, l], 'All after the move');
    const nested = await placeOf(page, c);
    assert(
      nested?.level === 3 && nested.prev === p,
      `All: C stays nested under P across Spaces: ${JSON.stringify(nested)}`,
    );
    await waitFact(
      () => labelOf(page, p),
      (lab) => spaced(pName, 'Beta').test(lab ?? ''),
      'All: P now names Beta',
    );
    assert(spaced('space-child', 'Alpha').test(await labelOf(page, c)), 'All: C still names Alpha');
    await selectSpace(page, alpha);
    await waitRows(page, [c], 'Alpha: only the child');
    assert((await placeOf(page, c))?.level === 2, 'Alpha: the child is a root, parent absent');
    await selectSpace(page, beta);
    await waitRows(page, [p], 'Beta: only the parent');
    const lone = await placeOf(page, p);
    assert(
      lone?.level === 2 && lone.item.expanded === null,
      `Beta: the parent has no children here: ${JSON.stringify(lone)}`,
    );
    assert(
      (await row(page, p).locator('[data-agent-action="fold"]').count()) === 0,
      'Beta: no fold control without visible children',
    );
    log('cross-Space: nested under All, separate roots under each Space ✓');

    phase('Move to space… moves one agent');
    await selectSpace(page, 'all');
    await moveViaPicker(page, p, 'Gamma');
    await waitFact(
      () => sessionOf(page, p),
      (s) => s?.projectId === gamma,
      'the picker moves P to Gamma',
    );
    await assertChildKeepsAlpha(page, c, alpha, 'the child still keeps Alpha');
    await selectSpace(page, gamma);
    await waitRows(page, [p], 'Gamma holds just P');
    await selectSpace(page, alpha);
    await waitRows(page, [c], 'Alpha still holds C');
    log('Move to space… → Gamma moves P alone ✓');

    phase('folds and pins');
    await selectSpace(page, 'all');
    await waitRows(page, [p, c, l], 'All');
    await row(page, p).locator('[data-agent-action="fold"]').click();
    await waitRows(page, [p, l], 'P folded');
    await row(page, l).locator('.session__name').click({ button: 'right' });
    await page.waitForSelector('.ctxmenu', { timeout: 5_000 });
    await page.locator('.ctxmenu__item', { hasText: exact('Pin to top') }).click();
    await waitFact(
      () => groupOf(page, l),
      (g) => g === 'pinned',
      'L moves under Pinned',
    );
    assert(
      (await row(page, l).locator('[data-agent-action="pin"]').getAttribute('aria-label')) ===
        'Unpin',
      'a pinned row offers Unpin',
    );
    await groupHeader(page, 'pinned').click();
    await waitRows(page, [p], 'Pinned folded');
    await selectSpace(page, gamma);
    log('P folded, L pinned, Pinned folded, Gamma selected in window 1 ✓');

    phase('second window');
    const page2 = await newWindow(app, page);
    await tapMcp(page2);
    const w = (await openFake(page2, dirs.w, { projectId: beta })).sessionId;
    await selectSpace(page2, beta);
    await waitRows(page2, [w], 'window 2 under Beta');
    assert((await pressed(page, gamma)) === 'true', 'window 1 keeps Gamma');

    phase('relaunch');
    await closeApp(app, page);
    let second = null;
    try {
      second = await launchApp({ userDataDir, openFolder: false });
      await waitWindows(second.app, 2, 20_000);
      const pages = second.app.windows();
      assert(pages.length === 2, `two windows restored, got ${pages.length}`);
      for (const pg of pages) {
        await pg.waitForFunction(() => !!window.agentDeck, null, { timeout: 20_000 });
        await tapBridge(pg);
      }
      const owner = async (id) => {
        for (const pg of pages) if ((await sessions(pg)).some((s) => s.id === id)) return pg;
        return null;
      };
      let w1 = null;
      let w2 = null;
      assert(
        await until(async () => {
          w1 = await owner(p);
          w2 = await owner(w);
          return w1 !== null && w2 !== null;
        }, 30_000),
        'each window gets its sessions back',
      );
      assert(w1 !== w2, 'P and W restore into separate windows');
      await waitFact(
        () => pressed(w1, gamma),
        (v) => v === 'true',
        'window 1 gets Gamma back',
      );
      await waitFact(
        () => pressed(w2, beta),
        (v) => v === 'true',
        'window 2 gets Beta back',
      );
      assert((await pressed(w1, 'all')) === 'false', 'window 1 is not reset to All');
      await waitRows(w1, [p], 'window 1 filters by Gamma after the restore');
      await waitRows(w2, [w], 'window 2 filters by Beta after the restore');
      log('each window restored its own Space selection ✓');

      await selectSpace(w1, 'all');
      const pinnedHead = groupHeader(w1, 'pinned');
      await pinnedHead.waitFor({ state: 'attached', timeout: 10_000 });
      assert(
        (await pinnedHead.getAttribute('aria-expanded')) === 'false',
        'the Pinned fold came back',
      );
      assert(
        (await pinnedHead.getAttribute('aria-label')) === 'Pinned (1)',
        `the pin came back: ${await pinnedHead.getAttribute('aria-label')}`,
      );
      await waitRows(w1, [p], 'folded P and folded Pinned hide C and L');
      assert((await row(w1, p).getAttribute('aria-expanded')) === 'false', 'P’s fold came back');
      await pinnedHead.click();
      await waitRows(w1, [p, l], 'Pinned unfolds to L');
      assert((await groupOf(w1, l)) === 'pinned', 'L is still pinned');
      await row(w1, p).locator('[data-agent-action="fold"]').click();
      await waitRows(w1, [p, c, l], 'P unfolds to C');
      assert(
        (await placeOf(w1, c))?.prev === p,
        `C is still nested under P: ${JSON.stringify(await rowIds(w1))}`,
      );
      assert((await pressed(w2, beta)) === 'true', 'window 1’s edits leave window 2 on Beta');
      log('folds, pin and group fold persisted; windows stay independent ✓');

      phase('cleanup');
      for (const pg of pages)
        for (const s of await sessions(pg))
          await pg.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
      assert(
        await until(async () => {
          for (const pg of pages) if ((await sessions(pg)).length > 0) return false;
          return true;
        }, 15_000),
        'sessions survived kill',
      );
      await closeApp(second.app, second.page);
      for (const d of Object.values(dirs)) await removeDir(d, { budgetMs: 10_000 });
    } finally {
      if (second) await shutdownApp(second.app, second.page);
    }
  },
  { userDataDir: fakeAgentProfile('space-filter') },
);
