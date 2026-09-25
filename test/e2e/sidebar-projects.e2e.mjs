/**
 * The sessions rail grouped by project (mf-sidebar spec §7.4), driven on the real app.
 *
 * Phase A — the group header: first-run and empty-after-action states, header order, inline
 * rename (surviving a relaunch), the hover +, Ctrl+N's project, Open board, Shift+F10, the filter
 * over root folders and agent labels, and the delete dialog.
 *
 * Phase B — moving a session: Move to project… (same PTY afterwards), + New project… (a double
 * Enter creates one project), Copy home path, a card dropped on another header (synthesized
 * DragEvents sharing one DataTransfer, as terminal-drop does) and on its own header (no-op), and
 * the hover × closing the session.
 *
 * Hover-revealed controls are clicked with a REAL pointer after `elementFromPoint` proves the
 * control wins the hit-test; Playwright's locator click would bypass that. Synthesized input
 * still bypasses Electron's app-region mask, so one real-mouse click on the + stays human smoke.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  createProject,
  launchApp,
  makeLog,
  openSession,
  removeDir,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[sidebar-projects] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('sidebar-projects');
const exact = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

const groupOf = (page, name) =>
  page.locator('.proj', { has: page.locator('.proj__name', { hasText: exact(name) }) });
const headerOf = (page, name) => groupOf(page, name).locator('.proj__label');

const headerNames = (page) =>
  page.$$eval('.sidebar .proj__label', (ls) =>
    ls.map((l) => l.querySelector('.proj__name, .proj__rename')?.textContent ?? ''),
  );

const sessionById = (page, id) =>
  page.evaluate((sid) => (window.__sessions || []).find((s) => s.id === sid) ?? null, id);

const liveRegion = (page) =>
  page.$eval('.sidebar [aria-live="polite"]', (el) => el.textContent.replace(/\u200b/g, ''));

async function headerMenu(page, name, item) {
  await headerOf(page, name).click({ button: 'right' });
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

/** A real pointer on the header, then prove the revealed + wins the hit-test at its centre. */
async function hoverPlus(page, name) {
  const box = await headerOf(page, name).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(350);
  const probe = await page.evaluate((n) => {
    const label = [...document.querySelectorAll('.proj__label')].find(
      (l) => l.querySelector('.proj__name')?.textContent === n,
    );
    const btn = label?.querySelector('.proj__add');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, wins: !!hit && btn.contains(hit), label: btn.getAttribute('aria-label') };
  }, name);
  assert(probe, `${name}: header has no + button`);
  assert(probe.wins, `${name}: the revealed + is not the hit target at its centre`);
  return probe;
}

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-ud-projects-'));
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
    (await page.textContent('.sidebar .emptystate__title')) === 'No sessions yet',
    'first-run title',
  );
  assert(
    (await page.textContent('.sidebar .emptystate__hint')) ===
      'A session is one terminal working across one or more folders. Run four at once.',
    'first-run hint',
  );
  assert((await page.locator('.sessbar').count()) === 0, 'first run shows no filter row');
  log('first-run copy ✓');

  const alphaId = await createProject(page, 'Alpha');
  const betaId = await createProject(page, 'Beta');
  await page.waitForFunction(() => document.querySelectorAll('.sidebar .proj__label').length === 2);
  const counts = await page.$$eval('.sidebar .proj__count', (cs) => cs.map((c) => c.textContent));
  assert(JSON.stringify(counts) === '["0","0"]', `empty projects show count 0, got ${counts}`);
  assert(
    (await page.locator('.sidebar .emptystate__title').count()) === 0,
    'projects exist: no first-run copy',
  );
  log('empty-after-action: two headers, count 0, no copy ✓');

  // ── Setup: one session per project, one standalone ───────────────────────
  const sAlpha = await openSession(page, { path: dirA, projectId: alphaId });
  const sBeta = await openSession(page, { path: dirB, roots: [dirR], projectId: betaId });
  const sLone = await openSession(page, { path: dirA });
  await page.waitForFunction(() => document.querySelectorAll('.sidebar .proj__label').length === 3);
  const order = await headerNames(page);
  assert(
    JSON.stringify(order) === '["Alpha","Beta","Standalone"]',
    `header order, got ${JSON.stringify(order)}`,
  );
  for (const n of ['Alpha', 'Beta', 'Standalone']) {
    const c = (await headerOf(page, n).locator('.proj__count').textContent())?.trim();
    assert(c === '1', `${n} count should be 1, got ${c}`);
  }
  assert(
    (await groupOf(page, 'Beta').locator(`.session[data-sessionid="${sBeta}"]`).count()) === 1,
    'the Beta session renders under Beta',
  );
  log('header order Alpha, Beta, Standalone; one session each ✓');

  // ── Rename, surviving a relaunch ─────────────────────────────────────────
  await headerMenu(page, 'Alpha', 'Rename…');
  const input = page.locator('.proj__rename');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  assert(
    await input.evaluate((el) => document.activeElement === el && el.selectionEnd === 5),
    'rename input is focused with the name selected',
  );
  await page.keyboard.type('Alpha2');
  await page.keyboard.press('Enter');
  await headerOf(page, 'Alpha2').waitFor({ state: 'attached', timeout: 5000 });
  log('rename → Alpha2 ✓');

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
  await headerOf(page, 'Alpha2').waitFor({ state: 'attached', timeout: 10000 });
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

  // ── Header + opens New session on that project ───────────────────────────
  const plus = await hoverPlus(page, 'Beta');
  assert(plus.label === 'New session in Beta', `Beta + label, got ${plus.label}`);
  await page.mouse.click(plus.x, plus.y);
  await page.waitForSelector('button.ns-chip__body[aria-label="Project: Beta"]', { timeout: 8000 });
  await escapeDialog(page);
  log('header + → New session on Beta ✓');

  // ── Ctrl+N takes the active session's project ────────────────────────────
  await page.locator(`.session[data-sessionid="${sAlpha}"] .session__name`).click();
  await page.waitForSelector(`.session--active[data-sessionid="${sAlpha}"]`, { timeout: 5000 });
  await page.keyboard.press('Control+N');
  await page.waitForSelector('button.ns-chip__body[aria-label="Project: Alpha2"]', {
    timeout: 8000,
  });
  await escapeDialog(page);
  log('Ctrl+N with an Alpha2 session active → Alpha2 ✓');

  // ── Open board selects the project's session and shows the board ─────────
  await headerMenu(page, 'Beta', 'Open board');
  await page.waitForSelector('.board', { state: 'visible', timeout: 8000 });
  const activeCard = await page.getAttribute('.session--active', 'data-sessionid');
  assert(activeCard === sBeta, `Open board should select Beta's session, got ${activeCard}`);
  await page.locator('.viewswitch__btn', { hasText: 'Workspace' }).click();
  await page.waitForSelector('.board', { state: 'detached', timeout: 5000 });
  log('Open board → Beta session active, Board shown ✓');

  // ── Shift+F10 on a chevron opens the header menu, first item highlighted ─
  const chevron = headerOf(page, 'Beta').locator('.proj__chevron');
  await chevron.focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForSelector('.ctxmenu', { timeout: 5000 });
  const activeItem = await page.textContent('.ctxmenu__item--active');
  assert(
    activeItem?.trim() === 'New session in project',
    `keyboard menu should highlight its first item, got ${activeItem}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  assert(
    await chevron.evaluate((el) => document.activeElement === el),
    'Escape returns focus to the chevron',
  );
  log('Shift+F10 → header menu, focus returns on Escape ✓');

  // ── Filter over a root folder name and an agent label ────────────────────
  const visibleIds = () =>
    page.$$eval('.sidebar .session', (cs) => cs.map((c) => c.getAttribute('data-sessionid')));
  // Read before filtering: the root filter below hides this card.
  const agentText = (
    await page.locator(`.session[data-sessionid="${sLone}"] .session__meta`).textContent()
  )
    ?.trim()
    .toLowerCase();
  assert(agentText, 'the standalone card shows its agent label');
  await page.fill('.sessbar__filter', 'rootfolder-zz');
  await page.waitForTimeout(150);
  const byRoot = await visibleIds();
  assert(JSON.stringify(byRoot) === JSON.stringify([sBeta]), `root filter, got ${byRoot}`);
  assert(
    (await page.locator('.sidebar .proj__label').count()) === 1,
    'a filter hides groups with no match (empty projects included)',
  );
  await page.fill('.sessbar__filter', agentText);
  await page.waitForTimeout(150);
  assert((await visibleIds()).includes(sLone), `agent-label filter "${agentText}" misses the card`);
  await page.fill('.sessbar__filter', '');
  log('filter by root folder and by agent label ✓');

  // ── Delete: Enter cancels; the danger button deletes; sessions go standalone ─
  await headerMenu(page, 'Alpha2', 'Delete project…');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  assert((await page.textContent('.confirm__title')) === 'Delete “Alpha2”?', 'delete dialog title');
  const msg = await page.textContent('.confirm__msg');
  assert(
    msg ===
      "Its 1 session becomes standalone and keeps running. Folders and their .conduit/ data aren't touched.",
    `delete dialog copy, got ${msg}`,
  );
  await page.keyboard.press('Enter');
  await page.waitForSelector('.confirm', { state: 'detached', timeout: 5000 });
  await page.waitForTimeout(500);
  assert(
    await page.evaluate((id) => (window.__projects || []).some((p) => p.id === id), alphaId),
    'Enter on the default focus must cancel, not delete',
  );
  log('Enter cancels the delete ✓');

  await headerMenu(page, 'Alpha2', 'Delete project…');
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
  await groupOf(page, 'Standalone')
    .locator(`.session[data-sessionid="${sAlpha}"]`)
    .waitFor({ state: 'attached', timeout: 5000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('.sidebar [aria-live="polite"]')
        ?.textContent.replace(/\u200b/g, '') === 'Deleted Alpha2',
    null,
    { timeout: 5000 },
  );
  log('delete → session standalone and running, announced ✓', await liveRegion(page));

  // ── Phase B: Move to project… keeps the PTY ──────────────────────────────
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
  // Only the age rendered on every card; the meter (Busy) and diffstat (Review) were per-state,
  // and no card here is in either — session-card.test.ts covers those two.
  const retired = await page.locator('.sidebar .session__age').count();
  assert(retired === 0, `the 9b card has no age, found ${retired}`);

  async function openPicker(id) {
    await card(id).click({ button: 'right', position: { x: 30, y: 10 } });
    await page.waitForSelector('.ctxmenu', { timeout: 5000 });
    await page.locator('.ctxmenu__item', { hasText: exact('Move to project…') }).click();
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
  await groupOf(page, 'Beta')
    .locator(`.session[data-sessionid="${sLone}"]`)
    .waitFor({ state: 'attached', timeout: 5000 });
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
  log('Move to project… → Beta, same PTY, announced ✓');

  // ── + New project… creates once, even on a double Enter ──────────────────
  await openPicker(sLone);
  await page.locator('.projpicker__new').click();
  const nameInput = page.locator('.projpicker__name');
  await nameInput.waitFor({ state: 'visible', timeout: 5000 });
  await nameInput.fill('RMB pipeline');
  await nameInput.press('Enter');
  await page.keyboard.press('Enter');
  await groupOf(page, 'RMB pipeline')
    .locator(`.session[data-sessionid="${sLone}"]`)
    .waitFor({ state: 'attached', timeout: 10000 });
  await page.waitForTimeout(800);
  const rmbCount = await page.evaluate(
    () => (window.__projects || []).filter((p) => p.name === 'RMB pipeline').length,
  );
  assert(rmbCount === 1, `a double Enter must create one project, got ${rmbCount}`);
  const namesNow = await headerNames(page);
  assert(
    namesNow.indexOf('RMB pipeline') >= 0 &&
      namesNow.indexOf('RMB pipeline') < namesNow.indexOf('Standalone'),
    `RMB pipeline should render above Standalone, got ${JSON.stringify(namesNow)}`,
  );
  log('+ New project… → one "RMB pipeline" holding the session ✓');

  // ── Copy home path ───────────────────────────────────────────────────────
  await card(sLone).click({ button: 'right', position: { x: 30, y: 10 } });
  await page.locator('.ctxmenu__item', { hasText: exact('Copy home path') }).click();
  const home = (await sessionById(page, sLone)).home;
  await page.waitForTimeout(200);
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

  // ── Drop a card on another group's header, then on its own ───────────────
  // dragend reports a point inside this window, so the host's cross-window hit-test no-ops.
  const bounds = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  const home_x = Math.round(bounds.x + bounds.width / 2);
  const home_y = Math.round(bounds.y + bounds.height / 2);
  const dropOnHeader = (sid, headerName) =>
    page.evaluate(
      async ({ sid, headerName, sx, sy }) => {
        const src = document.querySelector(`.sidebar .session[data-sessionid="${sid}"]`);
        const label = [...document.querySelectorAll('.proj__label')].find(
          (l) => l.querySelector('.proj__name')?.textContent === headerName,
        );
        if (!src || !label) return { error: 'missing card or header' };
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
        const cue = label.classList.contains('proj__label--dropinto');
        fire(label, 'drop');
        await tick();
        fire(src, 'dragend', { screenX: sx, screenY: sy });
        return { accepted, cue };
      },
      { sid, headerName, sx: home_x, sy: home_y },
    );

  const intoBeta = await dropOnHeader(sLone, 'Beta');
  assert(!intoBeta.error, `drag setup: ${intoBeta.error}`);
  assert(
    intoBeta.accepted && intoBeta.cue,
    `Beta should accept the card with a drop-into cue: ${JSON.stringify(intoBeta)}`,
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
  log('card dropped on Beta → filed into Beta, same window ✓');

  const ontoOwn = await dropOnHeader(sLone, 'Beta');
  assert(
    !ontoOwn.accepted && !ontoOwn.cue,
    `its own header must refuse the card with no cue: ${JSON.stringify(ontoOwn)}`,
  );
  await page.waitForTimeout(1000);
  assert(
    (await sessionById(page, sLone))?.projectId === betaId,
    'a drop on its own header changes nothing',
  );
  log('card dropped on its own header → no cue, no change ✓');

  // ── Hover × closes the session ───────────────────────────────────────────
  const cardBox = await card(sLone).boundingBox();
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.waitForTimeout(350);
  const kill = await page.evaluate((sid) => {
    const btn = document.querySelector(`.sidebar .session[data-sessionid="${sid}"] .session__kill`);
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, wins: !!hit && btn.contains(hit), label: btn.getAttribute('aria-label') };
  }, sLone);
  assert(kill, 'the hovered card has a close button');
  assert(kill.label === 'Close session', `× label, got ${kill.label}`);
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
process.exit(code);
