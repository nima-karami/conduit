/**
 * Projects as Spaces in the sidebar (mf-sidebar spec §7.4, sidebar-agent-tree spec §3/§6), driven
 * on the real app.
 *
 * Phase A — the Space rows: first-run and empty-after-action states, Space order, inline rename
 * from the Space menu and by double-click (surviving a relaunch), the Space menu's New agent in
 * space, Mod+N's Space, Open board, Shift+F10, the search-revealed filter over root folders and
 * agent labels, and the delete dialog.
 *
 * Phase B — moving a session: Move to space… (same PTY afterwards), + New space… (a double Enter
 * creates one Space), Copy home path, a row dropped on another Space row (synthesized DragEvents
 * sharing one DataTransfer, as terminal-drop does), on its own Space and on All (both no-ops), and
 * the hover × closing the session.
 *
 * Hover-revealed controls are clicked with a REAL pointer after `elementFromPoint` proves the
 * control wins the hit-test; Playwright's locator click would bypass that.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  createProject,
  e2ePlatformSupported,
  filterAgents,
  finishScenario,
  launchApp,
  makeLog,
  openSession,
  profileDir,
  removeDir,
  rowLabel,
  runCommand,
  selectSpace,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (!e2ePlatformSupported()) {
  console.log('[sidebar-projects] SKIP — suite does not run on this platform (macOS)');
  await finishScenario(0);
}

const log = makeLog('sidebar-projects');
const exact = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** A Space row by its exact accessible name (the Space's own name, spec \u00a73). */
const spaceOf = (page, name) =>
  page.locator(`.sidebar button[data-space-id][aria-label="${name.replace(/["\\]/g, '\\$&')}"]`);
const spaceRow = (page, key) => page.locator(`.sidebar button[data-space-id="${key}"]`);

const spaceNames = (page) =>
  page.$$eval('.sidebar button[data-space-id]', (ls) =>
    ls.map((l) => l.getAttribute('aria-label')),
  );

/** The Space row's description: "N agents" for All, the branch for a Space. */
const spaceDetail = (page, key) =>
  page.$eval(`.sidebar button[data-space-id="${key}"]`, (b) => {
    const id = b.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  });

const treeIds = (page) =>
  page.$$eval('.sidebar [data-agent-tree] .session', (cs) =>
    cs.map((c) => c.getAttribute('data-sessionid')),
  );

/** Wait until the tree shows exactly these rows, in any order. */
const waitTreeIds = (page, ids, timeout = 5000) =>
  page.waitForFunction(
    (want) => {
      const got = [...document.querySelectorAll('.sidebar [data-agent-tree] .session')].map((c) =>
        c.getAttribute('data-sessionid'),
      );
      return got.length === want.length && want.every((id) => got.includes(id));
    },
    ids,
    { timeout },
  );

const sessionById = (page, id) =>
  page.evaluate((sid) => (window.__sessions || []).find((s) => s.id === sid) ?? null, id);

/** Bounded negative: `forbidden(arg)` must stay falsy for the whole `ms` window. */
async function assertAbsentFor(page, ms, forbidden, what, arg = null) {
  try {
    await page.waitForFunction(forbidden, arg, { timeout: ms });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    return;
  }
  assert(false, `${what} appeared during the ${ms} ms observation window`);
}

const liveRegion = (page) =>
  page.$eval('.sidebar [aria-live="polite"]', (el) => el.textContent.replace(/\u200b/g, ''));

async function spaceMenu(page, name, item) {
  await spaceOf(page, name).click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { timeout: 5000 });
  await page.locator('.ctxmenu__item', { hasText: exact(item) }).click();
}

async function escapeDialog(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 5000 });
}

/** Kill every session and wait for the rail to be empty (the argv folder opens one at launch). */
async function killAll(page) {
  const ids = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));
  for (const id of ids)
    await page.evaluate((sid) => window.agentDeck.post({ type: 'kill', id: sid }), id);
  await page.waitForFunction(() => (window.__sessions || []).length === 0, null, {
    timeout: 15000,
  });
}

const userDataDir = profileDir('projects');
const work = mkdtempSync(join(tmpdir(), 'conduit-projects-'));
let launched = null;
let code = 0;
try {
  const dirA = join(work, 'home-a');
  const dirB = join(work, 'home-b');
  const dirR = join(work, 'rootfolder-zz');
  for (const d of [dirA, dirB, dirR]) mkdirSync(d);

  launched = await launchApp({ userDataDir });
  let { page } = launched;
  await tapBridge(page);
  await page.waitForFunction(() => (window.__sessions || []).length > 0, null, { timeout: 25000 });

  // ── Empty states (AC 12) ─────────────────────────────────────────────────
  await killAll(page);
  await page.waitForSelector('.sidebar .emptystate__title', { timeout: 5000 });
  assert(
    (await page.textContent('.sidebar .emptystate__title')) === 'No agents yet',
    'first-run title',
  );
  assert(
    (await page.textContent('.sidebar .emptystate__hint')) ===
      'An agent is one terminal working across one or more folders. Run four at once.',
    'first-run hint',
  );
  // The filter is no longer a standing row: it hides behind Search agents (spec §9).
  const search = page.getByRole('button', { name: 'Search agents', exact: true });
  assert(
    (await search.getAttribute('aria-expanded')) === 'false',
    'first run: Search agents is collapsed',
  );
  assert(
    (await page.locator('.sessbar, input.sessbar__filter').count()) === 0,
    'first run shows no filter input',
  );
  assert((await spaceDetail(page, 'all')) === '0 agents', 'first run: All describes 0 agents');
  log('first-run copy, collapsed search, All 0 agents ✓');

  const alphaId = await createProject(page, 'Alpha');
  const betaId = await createProject(page, 'Beta');
  await page.waitForFunction(
    (ids) => ids.every((id) => document.querySelector(`.sidebar button[data-space-id="${id}"]`)),
    [alphaId, betaId],
  );
  const emptyOrder = await spaceNames(page);
  assert(
    JSON.stringify(emptyOrder) === '["All","Alpha","Beta"]',
    `empty Spaces render as rows under All (no No space without loose agents), got ${JSON.stringify(emptyOrder)}`,
  );
  assert((await spaceDetail(page, 'all')) === '0 agents', 'empty Spaces add no agents to All');
  // Zero agents is still the first run (spec §9 table): the Spaces exist above it.
  assert(
    (await page.textContent('.sidebar .emptystate__title')) === 'No agents yet',
    'Spaces without agents keep the first-run copy',
  );
  log('empty-after-action: two Space rows, All 0 agents ✓');

  // ── Setup: one session per project, one standalone ───────────────────────
  const sAlpha = await openSession(page, { path: dirA, projectId: alphaId });
  const sBeta = await openSession(page, { path: dirB, roots: [dirR], projectId: betaId });
  const sLone = await openSession(page, { path: dirA });
  await page.waitForSelector('.sidebar button[data-space-id="no-space"]', { timeout: 10000 });
  const order = await spaceNames(page);
  assert(
    JSON.stringify(order) === '["All","Alpha","Beta","No space"]',
    `Space order, got ${JSON.stringify(order)}`,
  );
  assert((await spaceDetail(page, 'all')) === '3 agents', 'All counts the three agents');
  // A Space row shows no count of its own; selecting it is how its membership shows.
  for (const [key, sid] of [
    [alphaId, sAlpha],
    [betaId, sBeta],
    ['no-space', sLone],
  ]) {
    await selectSpace(page, key);
    await waitTreeIds(page, [sid]).catch(async () => {
      assert(false, `Space ${key} should show only ${sid}, got ${await treeIds(page)}`);
    });
  }
  await selectSpace(page, 'all');
  await waitTreeIds(page, [sAlpha, sBeta, sLone]);
  const betaLabel = await rowLabel(page, sBeta);
  assert(/, Beta$/.test(betaLabel ?? ''), `under All a row names its Space, got ${betaLabel}`);
  log('Space order All, Alpha, Beta, No space; one agent each ✓');

  // ── Rename, surviving a relaunch ─────────────────────────────────────────
  await spaceMenu(page, 'Alpha', 'Rename…');
  const input = page.locator('.sidebar .spaces input.proj__rename');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  assert(
    await input.evaluate((el) => document.activeElement === el && el.selectionEnd === 5),
    'rename input is focused with the name selected',
  );
  await page.keyboard.type('Alpha2');
  await page.keyboard.press('Enter');
  await spaceOf(page, 'Alpha2').waitFor({ state: 'attached', timeout: 5000 });
  assert(
    (await spaceRow(page, alphaId).getAttribute('aria-label')) === 'Alpha2',
    'the renamed Space keeps its id',
  );
  log('rename → Alpha2 ✓');

  // Double-click is the other way into rename; Escape leaves the name alone.
  await spaceOf(page, 'Beta').dblclick();
  await input.waitFor({ state: 'visible', timeout: 5000 });
  assert((await input.inputValue()) === 'Beta', 'double-click opens rename on that Space');
  await page.keyboard.press('Escape');
  await spaceOf(page, 'Beta').waitFor({ state: 'visible', timeout: 5000 });
  assert(
    (await page.evaluate(
      (id) => (window.__projects || []).find((p) => p.id === id)?.name,
      betaId,
    )) === 'Beta',
    'Escape cancels the rename',
  );
  // The double-click's first click selected Beta; the selection persists per window.
  await selectSpace(page, 'all');
  log('double-click rename, Escape cancels ✓');

  await shutdownApp(launched.app, launched.page);
  launched = await launchApp({ userDataDir });
  page = launched.page;
  // window.__terms (Phase B reads a terminal's buffer) is opt-in and read at pane mount, so it
  // must exist before the bundle runs: addInitScript + one reload.
  await page.addInitScript(() => {
    window.__terms = {};
  });
  await page.reload();
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  await page.waitForFunction(
    (ids) => ids.every((id) => (window.__sessions || []).some((s) => s.id === id)),
    [sAlpha, sBeta, sLone],
    { timeout: 45000 },
  );
  await spaceOf(page, 'Alpha2').waitFor({ state: 'attached', timeout: 10000 });
  log('Alpha2 survives a relaunch ✓');
  // Restored sessions come back stale and the argv folder opens another; relaunch ours so the
  // delete below proves "keeps running" against a live process, and drop the extra.
  const ours = [sAlpha, sBeta, sLone];
  const extra = await page.evaluate(
    (keep) => (window.__sessions || []).map((s) => s.id).filter((id) => !keep.includes(id)),
    ours,
  );
  for (const id of extra)
    await page.evaluate((sid) => window.agentDeck.post({ type: 'kill', id: sid }), id);
  for (const id of ours) {
    const s = await sessionById(page, id);
    if (s?.status !== 'running')
      await page.evaluate((sid) => window.agentDeck.post({ type: 'relaunch', id: sid }), id);
  }
  await page.waitForFunction(
    (keep) => {
      const ss = window.__sessions || [];
      return (
        ss.length === keep.length && ss.every((s) => keep.includes(s.id) && s.status === 'running')
      );
    },
    ours,
    { timeout: 30000 },
  );

  // ── The Space menu's New agent in space opens New agent on that Space ────
  // (the old header's hover + is gone; the Space menu carries it, spec §3)
  await spaceOf(page, 'Beta').click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { timeout: 5000 });
  const spaceItems = await page.$$eval('.ctxmenu .ctxmenu__item .ctxmenu__label', (els) =>
    els.map((e) => e.textContent.trim()),
  );
  assert(
    JSON.stringify(spaceItems) ===
      JSON.stringify(['New agent in space', 'Open board', 'Rename…', 'Delete space…']),
    `Space menu items, got ${JSON.stringify(spaceItems)}`,
  );
  await page.locator('.ctxmenu__item', { hasText: exact('New agent in space') }).click();
  await page.waitForSelector('button.ns-chip__body[aria-label="Space: Beta"]', { timeout: 8000 });
  await escapeDialog(page);
  log('Space menu New agent in space → New agent on Beta ✓');

  // ── Mod+N under All takes the last focused agent's Space ─────────────────
  await page.locator(`.session[data-sessionid="${sAlpha}"] .session__name`).click();
  await page.waitForSelector(`.session--active[data-sessionid="${sAlpha}"]`, { timeout: 5000 });
  await page.keyboard.press('Control+N');
  await page.waitForSelector('button.ns-chip__body[aria-label="Space: Alpha2"]', {
    timeout: 8000,
  });
  await escapeDialog(page);
  log('Ctrl+N with an Alpha2 session active → Alpha2 ✓');

  // ── Open board selects the project's session and shows the board ─────────
  await spaceMenu(page, 'Beta', 'Open board');
  await page.waitForSelector('.board', { state: 'visible', timeout: 8000 });
  const activeCard = await page.getAttribute('.session--active', 'data-sessionid');
  assert(activeCard === sBeta, `Open board should select Beta's session, got ${activeCard}`);
  await runCommand(page, 'Open editor');
  await page.waitForSelector('.board', { state: 'detached', timeout: 5000 });
  log('Open board → Beta session active, Board shown ✓');

  // ── Shift+F10 on a Space row opens its menu, first item highlighted ──────
  const betaSpace = spaceOf(page, 'Beta');
  await betaSpace.focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForSelector('.ctxmenu', { timeout: 5000 });
  const activeItem = await page.textContent('.ctxmenu__item--active');
  assert(
    activeItem?.trim() === 'New agent in space',
    `keyboard menu should highlight its first item, got ${activeItem}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  assert(
    await betaSpace.evaluate((el) => document.activeElement === el),
    'Escape returns focus to the Space row',
  );
  log('Shift+F10 → Space menu, focus returns on Escape ✓');

  // ── Filter over a root folder name and an agent label ────────────────────
  // Read before filtering: the root filter below hides this row. The old card's agent subtitle
  // now lives in the row tooltip, third line (name, status, agent… — agentRowTooltip).
  const loneTip = (await page.getAttribute(`.session[data-sessionid="${sLone}"]`, 'title')) ?? '';
  const agentText = loneTip.split('\n')[2]?.trim().toLowerCase();
  assert(agentText, `the standalone row's tooltip names its agent, got ${JSON.stringify(loneTip)}`);
  await filterAgents(page, 'rootfolder-zz');
  await waitTreeIds(page, [sBeta]).catch(async () => {
    assert(false, `root filter should leave only ${sBeta}, got ${await treeIds(page)}`);
  });
  const groupHeads = await page.$$eval('.sidebar [data-agent-tree] .proj__label', (ls) =>
    ls.map((l) => l.querySelector('.proj__count')?.textContent),
  );
  assert(
    JSON.stringify(groupHeads) === '["1"]',
    `a filter hides status groups with no match, got counts ${JSON.stringify(groupHeads)}`,
  );
  await filterAgents(page, agentText);
  await page
    .waitForFunction(
      (sid) =>
        !!document.querySelector(`.sidebar [data-agent-tree] .session[data-sessionid="${sid}"]`),
      sLone,
      { timeout: 5000 },
    )
    .catch(() => assert(false, `agent-label filter "${agentText}" misses the row`));
  await filterAgents(page, '');
  await waitTreeIds(page, [sAlpha, sBeta, sLone]);
  log('filter by root folder and by agent label ✓');

  // ── Delete: Enter cancels; the danger button deletes; sessions go standalone ─
  await spaceMenu(page, 'Alpha2', 'Delete space…');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  assert((await page.textContent('.confirm__title')) === 'Delete “Alpha2”?', 'delete dialog title');
  const msg = await page.textContent('.confirm__msg');
  assert(
    msg ===
      "Its 1 agent keeps running without a space. Folders and their .conduit/ data aren't touched.",
    `delete dialog copy, got ${msg}`,
  );
  await page.keyboard.press('Enter');
  await page.waitForSelector('.confirm', { state: 'detached', timeout: 5000 });
  await assertAbsentFor(
    page,
    500,
    (id) => !(window.__projects || []).some((p) => p.id === id),
    'the cancelled delete removing the space',
    alphaId,
  );
  assert(
    await page.evaluate((id) => (window.__projects || []).some((p) => p.id === id), alphaId),
    'Enter on the default focus must cancel, not delete',
  );
  log('Enter cancels the delete ✓');

  await spaceMenu(page, 'Alpha2', 'Delete space…');
  assert(
    (await page.textContent('.confirm .btn--danger'))?.trim() === 'Delete space',
    'the danger button says Delete space',
  );
  await page.click('.confirm .btn--danger');
  await page.waitForFunction((id) => !(window.__projects || []).some((p) => p.id === id), alphaId, {
    timeout: 10000,
  });
  await page.waitForFunction(
    (sid) => {
      const s = (window.__sessions || []).find((x) => x.id === sid);
      return !!s && s.projectId === undefined;
    },
    sAlpha,
    { timeout: 10000 },
  );
  const after = await sessionById(page, sAlpha);
  assert(
    after.status === 'running',
    `the deleted project's session must keep running, got ${after.status}`,
  );
  await spaceRow(page, alphaId).waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForFunction(
    (sid) =>
      document
        .querySelector(`.sidebar [data-agent-tree] .session[data-sessionid="${sid}"]`)
        ?.getAttribute('aria-label')
        ?.split(', ').length === 2,
    sAlpha,
    { timeout: 5000 },
  );
  await selectSpace(page, 'no-space');
  await waitTreeIds(page, [sAlpha, sLone]).catch(async () => {
    assert(false, `No space should hold the deleted Space's agent, got ${await treeIds(page)}`);
  });
  await selectSpace(page, 'all');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.sidebar [aria-live="polite"]')
        ?.textContent.replace(/\u200b/g, '') === 'Deleted Alpha2',
    null,
    { timeout: 5000 },
  );
  log('delete → session standalone and running, announced ✓', await liveRegion(page));

  // ── Phase B: Move to space… keeps the PTY ────────────────────────────────
  const loneName = (await sessionById(page, sLone)).name;
  const card = (id) => page.locator(`.sidebar .session[data-sessionid="${id}"]`);
  const beforeActivate = await page.evaluate((sid) => (window.__capBy?.[sid] ?? '').length, sLone);
  await card(sLone).locator('.session__name').click();
  await page.waitForSelector(`.session--active[data-sessionid="${sLone}"]`, { timeout: 5000 });
  // The relaunched PTY only spawns once its pane is shown (measured ~0.9 s after activation), and
  // input before that is dropped: wait for the new shell to print past the relaunch marker.
  await page.waitForFunction(
    ([sid, from]) => {
      const out = (window.__capBy?.[sid] ?? '').slice(from);
      const at = out.lastIndexOf('— session relaunched —');
      return at >= 0 && out.slice(at + '— session relaunched —'.length).trim().length > 0;
    },
    [sLone, beforeActivate],
    { timeout: 20000 },
  );
  await page.evaluate(
    (sid) =>
      window.agentDeck.post({ type: 'term:input', sessionId: sid, data: 'echo MARKER_MF_ZZ\r' }),
    sLone,
  );
  await page.waitForFunction(
    (sid) => (window.__capBy?.[sid] ?? '').split('MARKER_MF_ZZ').length >= 3,
    sLone,
    { timeout: 20000 },
  );
  // Read the terminal's buffer, not `.xterm-rows`: the WebGL renderer paints to a canvas and leaves
  // those rows empty, so a DOM read only ever passed on the DOM-renderer fallback.
  const termHasMarker = () =>
    page.evaluate((sid) => {
      const t = window.__terms?.[sid];
      if (!t?.element?.checkVisibility()) return false;
      const b = t.buffer.active;
      for (let i = 0; i < b.length; i++) {
        if (b.getLine(i)?.translateToString(true).includes('MARKER_MF_ZZ')) return true;
      }
      return false;
    }, sLone);
  assert(await termHasMarker(), 'precondition: the marker is on the visible terminal');
  // The agent row brings back one state age (spec §6: <1m / Nm / Nh / Nd), hidden from the
  // accessible name, which carries the status word instead.
  const ages = await page.$$eval('.sidebar [data-agent-tree] .session', (rows) =>
    rows.map((r) => {
      const a = r.querySelector('.session__age');
      return a ? { text: a.textContent, hidden: a.getAttribute('aria-hidden') } : null;
    }),
  );
  assert(
    ages.length === 3 &&
      ages.every((a) => a && /^(<1m|\d+[mhd])$/.test(a.text) && a.hidden === 'true'),
    `every row shows an aria-hidden state age, got ${JSON.stringify(ages)}`,
  );

  async function openPicker(id) {
    await card(id).click({ button: 'right', position: { x: 30, y: 10 } });
    await page.waitForSelector('.ctxmenu', { timeout: 5000 });
    await page.locator('.ctxmenu__item', { hasText: exact('Move to space…') }).click();
    await page.waitForSelector('.projpicker', { timeout: 5000 });
  }

  await openPicker(sLone);
  assert(
    await page.evaluate(() => document.activeElement?.classList.contains('projpicker__filter')),
    'the picker filter takes focus on open',
  );
  await page.locator('.projpicker__row', { hasText: exact('Beta') }).click();
  await page.waitForFunction(
    ({ sid, pid }) => (window.__sessions || []).find((s) => s.id === sid)?.projectId === pid,
    { sid: sLone, pid: betaId },
    { timeout: 10000 },
  );
  await page.waitForFunction(
    (sid) =>
      /, Beta$/.test(
        document
          .querySelector(`.sidebar [data-agent-tree] .session[data-sessionid="${sid}"]`)
          ?.getAttribute('aria-label') ?? '',
      ),
    sLone,
    { timeout: 5000 },
  );
  assert((await sessionById(page, sLone)).status === 'running', 'the moved session keeps running');
  assert(await termHasMarker(), 'the moved session still shows its earlier output (same PTY)');
  await page.waitForFunction(
    (want) =>
      document
        .querySelector('.sidebar [aria-live="polite"]')
        ?.textContent.replace(/\u200b/g, '') === want,
    `Moved ${loneName} to Beta`,
    { timeout: 10000 },
  );
  log('Move to space… → Beta, same PTY, announced ✓');

  // ── + New space… creates once, even on a double Enter ────────────────────
  await openPicker(sLone);
  assert(
    (await page.textContent('.projpicker__new'))?.trim() === '+ New space…',
    'the picker offers + New space…',
  );
  await page.locator('.projpicker__new').click();
  const nameInput = page.locator('.projpicker__name');
  await nameInput.waitFor({ state: 'visible', timeout: 5000 });
  await nameInput.fill('RMB pipeline');
  await nameInput.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (sid) =>
      /, RMB pipeline$/.test(
        document
          .querySelector(`.sidebar [data-agent-tree] .session[data-sessionid="${sid}"]`)
          ?.getAttribute('aria-label') ?? '',
      ),
    sLone,
    { timeout: 10000 },
  );
  await assertAbsentFor(
    page,
    800,
    () => (window.__projects || []).filter((p) => p.name === 'RMB pipeline').length > 1,
    'a second RMB pipeline project',
  );
  const rmbCount = await page.evaluate(
    () => (window.__projects || []).filter((p) => p.name === 'RMB pipeline').length,
  );
  assert(rmbCount === 1, `a double Enter must create one project, got ${rmbCount}`);
  const namesNow = await spaceNames(page);
  assert(
    namesNow.indexOf('RMB pipeline') > namesNow.indexOf('Beta') &&
      namesNow.indexOf('RMB pipeline') < namesNow.indexOf('No space'),
    `RMB pipeline should render after Beta and above No space, got ${JSON.stringify(namesNow)}`,
  );
  log('+ New space… → one "RMB pipeline" holding the session ✓');

  // ── Copy home path ───────────────────────────────────────────────────────
  await card(sLone).click({ button: 'right', position: { x: 30, y: 10 } });
  await page.locator('.ctxmenu__item', { hasText: exact('Copy home path') }).click();
  const home = (await sessionById(page, sLone)).home;
  // The host writes the clipboard after the menu action; wait for the home path (a machine with a
  // dead clipboard never matches and falls to the precondition probe below).
  await launched.app.evaluate(
    ({ clipboard }, want) =>
      new Promise((resolve) => {
        const deadline = Date.now() + 3000;
        const tick = () => {
          if (clipboard.readText() === want || Date.now() >= deadline) return resolve();
          setTimeout(tick, 5);
        };
        tick();
      }),
    home,
  );
  const clip = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
  // A machine whose clipboard refuses every write (paste.e2e's precondition: OpenClipboard error 5)
  // can't prove this step. Tell it apart from a product miss with a round-trip in the main process,
  // and fail at the end with that reason so the phases after this one still run and prove.
  let clipboardPrecondition = null;
  if (clip !== home) {
    const probe = await launched.app.evaluate(({ clipboard }) => {
      clipboard.writeText('conduit-clipboard-probe');
      return clipboard.readText();
    });
    assert(
      probe !== 'conduit-clipboard-probe',
      `Copy home path: clipboard ${JSON.stringify(clip)} ≠ home ${home}`,
    );
    clipboardPrecondition =
      'PRECONDITION (machine, not product): the system clipboard is not usable — a main-process ' +
      `writeText/readText round-trip read back ${JSON.stringify(probe)}, so Copy home path is unproven`;
    log(clipboardPrecondition);
  } else log('Copy home path ✓');

  // ── Drop a row on another Space row, then on its own, then on All ────────
  // dragend reports a point inside this window, so the host's cross-window hit-test no-ops.
  const bounds = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  const home_x = Math.round(bounds.x + bounds.width / 2);
  const home_y = Math.round(bounds.y + bounds.height / 2);
  const dropOnSpace = (sid, spaceKey) =>
    page.evaluate(
      async ({ sid, spaceKey, sx, sy }) => {
        const src = document.querySelector(`.sidebar .session[data-sessionid="${sid}"]`);
        const label = document.querySelector(`.sidebar button[data-space-id="${spaceKey}"]`);
        if (!src || !label) return { error: 'missing row or Space' };
        const dt = new DataTransfer();
        const fire = (el, type, extra = {}) =>
          el.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }),
          );
        const tick = () => new Promise((r) => setTimeout(r, 60));
        fire(src, 'dragstart');
        await tick();
        const accepted = !fire(label, 'dragover');
        await tick();
        const cue = label.classList.contains('space--drop');
        fire(label, 'drop');
        await tick();
        const cueAfter = label.isConnected && label.classList.contains('space--drop');
        fire(src, 'dragend', { screenX: sx, screenY: sy });
        return { accepted, cue, cueAfter };
      },
      { sid, spaceKey, sx: home_x, sy: home_y },
    );

  const othersBefore = await page.evaluate(
    (ids) => ids.map((id) => (window.__sessions || []).find((s) => s.id === id)?.projectId ?? null),
    [sAlpha, sBeta],
  );
  const intoBeta = await dropOnSpace(sLone, betaId);
  assert(!intoBeta.error, `drag setup: ${intoBeta.error}`);
  assert(
    intoBeta.accepted && intoBeta.cue && !intoBeta.cueAfter,
    `Beta should accept the row with a drop cue that clears on drop: ${JSON.stringify(intoBeta)}`,
  );
  await page.waitForFunction(
    ({ sid, pid }) => (window.__sessions || []).find((s) => s.id === sid)?.projectId === pid,
    { sid: sLone, pid: betaId },
    { timeout: 10000 },
  );
  assert(
    await page.evaluate((sid) => (window.__sessions || []).some((s) => s.id === sid), sLone),
    'the dropped session stays in this window',
  );
  const othersAfter = await page.evaluate(
    (ids) => ids.map((id) => (window.__sessions || []).find((s) => s.id === id)?.projectId ?? null),
    [sAlpha, sBeta],
  );
  assert(
    JSON.stringify(othersAfter) === JSON.stringify(othersBefore),
    `only the dropped session moves: ${JSON.stringify({ othersBefore, othersAfter })}`,
  );
  log('row dropped on Beta → filed into Beta, only it moved, same window ✓');

  const ontoOwn = await dropOnSpace(sLone, betaId);
  assert(
    !ontoOwn.error && !ontoOwn.accepted && !ontoOwn.cue,
    `its own Space must refuse the row with no cue: ${JSON.stringify(ontoOwn)}`,
  );
  const ontoAll = await dropOnSpace(sLone, 'all');
  assert(
    !ontoAll.error && !ontoAll.accepted && !ontoAll.cue,
    `All is never a drop target: ${JSON.stringify(ontoAll)}`,
  );
  await assertAbsentFor(
    page,
    1000,
    ([sid, want]) => (window.__sessions || []).find((s) => s.id === sid)?.projectId !== want,
    'a project change from a drop on its own Space or All',
    [sLone, betaId],
  );
  assert(
    (await sessionById(page, sLone))?.projectId === betaId,
    'a drop on its own Space or on All changes nothing',
  );
  log('row dropped on its own Space and on All → no cue, no change ✓');

  // ── Hover × closes the session ───────────────────────────────────────────
  const cardBox = await card(sLone).boundingBox();
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.waitForFunction(
    (sid) => {
      const btn = document.querySelector(
        `.sidebar .session[data-sessionid="${sid}"] .session__kill`,
      );
      return !!btn && getComputedStyle(btn).pointerEvents === 'auto';
    },
    sLone,
    { timeout: 5000 },
  );
  const kill = await page.evaluate((sid) => {
    const btn = document.querySelector(`.sidebar .session[data-sessionid="${sid}"] .session__kill`);
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, wins: !!hit && btn.contains(hit), label: btn.getAttribute('aria-label') };
  }, sLone);
  assert(kill, 'the hovered row has a close button');
  assert(kill.label === `Close ${loneName}`, `× label, got ${kill.label}`);
  assert(kill.wins, 'the revealed × is not the hit target at its centre');
  await page.mouse.click(kill.x, kill.y);
  const confirmShown = await page
    .waitForSelector('.confirm', { timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (confirmShown) await page.click('.confirm .btn--danger');
  await page.waitForFunction((sid) => !(window.__sessions || []).some((s) => s.id === sid), sLone, {
    timeout: 10000,
  });
  log('hover × → session closed ✓');

  assert(clipboardPrecondition === null, clipboardPrecondition);
  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[sidebar-projects] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
for (const dir of [work, userDataDir]) {
  await removeDir(dir, { budgetMs: 5000 }).catch((e) => log('cleanup:', dir, e?.code ?? e));
}
await finishScenario(code);
