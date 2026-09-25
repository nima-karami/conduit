/**
 * Board card ↔ sessions, end to end (spec docs/specs/2026-09-23-mf-board.md §9): the ticket
 * header, one row per linked session, + Start session into a prefilled New session dialog, a
 * keyboard and a mouse jump from a row, a closed session leaving the card without a board write,
 * a session on another home not listed, and a drag that starts on the pill still moving the card
 * with its ticket intact.
 *
 * The pill is dragged twice. page.mouse drives the card's native HTML5 drag here (mf-board QA
 * measured it), which proves a press on the pill starts a drag rather than a click; the
 * synthesized DataTransfer drag then pins the card's drop wiring independently of OS input.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  createProject,
  openSession,
  removeDir,
  runScenario,
  tapBridge,
} from './harness.mjs';

const CARD_ID = 'card-e2e';
const TITLE = 'Move RMB to CI';
const TICKET = { key: 'RMB-412', source: 'Jira', status: 'In progress' };

// The dialog bookends a path with LRMs so it truncates from the left, and Windows hands back
// either separator and drive case: the assertions are about WHICH folder, not its spelling.
const norm = (p) =>
  String(p)
    .replace(/[\u200e\s]/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

runScenario('board-sessions', async ({ app, page, log }) => {
  const H = mkdtempSync(join(tmpdir(), 'mfboard-home-'));
  const R = mkdtempSync(join(tmpdir(), 'mfboard-root-'));
  let passed = false;
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: H });
    mkdirSync(join(H, '.conduit'));
    const boardFile = join(H, '.conduit', 'board.json');
    writeFileSync(
      boardFile,
      JSON.stringify({
        conduit: 1,
        kind: 'board',
        updatedAt: Date.now(),
        data: {
          version: 1,
          cards: [{ id: CARD_ID, title: TITLE, notes: '', stage: 'building', ticket: TICKET }],
        },
      }),
    );
    const readData = () => JSON.parse(readFileSync(boardFile, 'utf8')).data;

    await tapBridge(page);
    await page.evaluate(() => {
      window.__agents = null;
      window.agentDeck.subscribe((m) => {
        if (m.type === 'state') window.__agents = m.agents;
      });
      window.agentDeck.post({ type: 'ready' });
    });
    const agents = await page.waitForFunction(() => window.__agents).then((h) => h.jsonValue());
    const label = agents.find((a) => a.id === 'shell:cmd')?.label ?? 'shell:cmd';

    const P = await createProject(page, 'RMB');
    const S1 = await openSession(page, { path: H, roots: [R], projectId: P, cardId: CARD_ID });
    const rename = (id, name) =>
      page.evaluate((a) => window.agentDeck.post({ type: 'rename', id: a.id, name: a.name }), {
        id,
        name,
      });
    // Two sessions on H would both be named after H; distinct names let a row say which it is.
    await rename(S1, 'rmb-first');
    await page.waitForFunction(
      (id) => window.__sessions.find((s) => s.id === id)?.name === 'rmb-first',
      S1,
    );

    // A fresh profile, so this is the shipped default (spec §9 Background), not a seeded value.
    const autoSwitch = await page.evaluate(
      () => window.agentDeck.initialSettings?.autoSwitchSession,
    );
    assert(autoSwitch !== false, `autoSwitchSession is on by default (got ${autoSwitch})`);

    const card = page.locator('.bcard', { hasText: TITLE }).first();
    const openBoard = async () => {
      if ((await page.locator('.board').count()) === 0) {
        await page.locator('.viewswitch__btn[title="Feature Board"]').click();
      }
      await card.waitFor({ state: 'visible', timeout: 15000 });
    };
    const rowLabels = () =>
      card
        .locator('ul.bcard__sessions > li > button.bcard__session')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    const waitRows = async (expected, what) => {
      await page
        .waitForFunction(
          ({ title, want }) => {
            const c = [...document.querySelectorAll('.bcard')].find((el) =>
              el.textContent.includes(title),
            );
            const got = c
              ? [...c.querySelectorAll('.bcard__session')].map((b) => b.getAttribute('aria-label'))
              : [];
            return JSON.stringify(got) === JSON.stringify(want);
          },
          { title: TITLE, want: expected },
          { timeout: 10000 },
        )
        .catch(() => {});
      const got = await rowLabels();
      assert(
        JSON.stringify(got) === JSON.stringify(expected),
        `${what}: rows ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
      );
    };
    // A real mouse click lands on whatever is on top at that point, so first prove it is `el`.
    const realClick = async (locator, what) => {
      const box = await locator.boundingBox();
      assert(box, `${what} has a box`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const hit = await locator.evaluate(
        (el, pt) => {
          const top = document.elementFromPoint(pt.x, pt.y);
          return !!top && (top === el || el.contains(top));
        },
        { x, y },
      );
      assert(hit, `${what} is the topmost element at its centre`);
      await page.mouse.click(x, y);
    };

    const closeBoard = async () => {
      if ((await page.locator('.board').count()) > 0) {
        await page.locator('.viewswitch__btn[title="Editor"]').click();
        await page.waitForSelector('.board', { state: 'detached', timeout: 10000 });
      }
    };
    const activateViaSidebar = async (id, what) => {
      await closeBoard();
      await realClick(
        page.locator(`.session[data-sessionid="${id}"]`),
        `the sidebar card for ${what}`,
      );
      await page.waitForSelector(`.session--active[data-sessionid="${id}"]`, { timeout: 10000 });
    };
    const assertOnlyActive = async (id, what) => {
      const active = await page
        .locator('.session--active')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-sessionid')));
      assert(
        JSON.stringify(active) === JSON.stringify([id]),
        `${what} makes it the one active session (active: ${JSON.stringify(active)})`,
      );
    };
    const column = (name) =>
      page.locator('.bcol').filter({ has: page.locator('.bcol__title', { hasText: name }) });
    const savedStage = async (want) => {
      const deadline = Date.now() + 5000;
      let saved = readData().cards[0];
      while (saved.stage !== want && Date.now() < deadline) {
        await page.waitForTimeout(100);
        saved = readData().cards[0];
      }
      return saved;
    };

    // ── Scenario 1: header and list ─────────────────────────────────────────
    await openBoard();
    const texts = await Promise.all(
      ['.bcard__tkey', '.bcard__tsource', '.bcard__tstatus'].map((s) =>
        card.locator(s).innerText(),
      ),
    );
    assert(
      JSON.stringify(texts) === JSON.stringify([TICKET.key, TICKET.source, TICKET.status]),
      `ticket header reads key/source/status (got ${JSON.stringify(texts)})`,
    );
    await waitRows([`rmb-first, ${label}, running`], 'one linked row');
    assert(
      (await page.evaluate(() => document.querySelectorAll('.bcard__badge').length)) === 0,
      'the old .bcard__badge is gone',
    );
    const sideText = await page.locator(`.session[data-sessionid="${S1}"]`).innerText();
    assert(
      !sideText.includes(TICKET.key) && !sideText.includes(TITLE),
      `the sidebar card shows no ticket or card title (got ${JSON.stringify(sideText)})`,
    );
    log('scenario 1: ticket header, one row, no badge, sidebar clean ✓');

    // ── Scenario 2: start a second session from the card ────────────────────
    const pill = card.locator('button.bcard__start');
    await realClick(pill, '+ Start session');
    await page.waitForSelector('.modal.ns', { state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10000 });
    const focusBack = await page.evaluate((title) => {
      const a = document.activeElement;
      return (
        !!a?.classList.contains('bcard__start') &&
        !!a.closest('.bcard')?.textContent.includes(title)
      );
    }, TITLE);
    assert(focusBack, 'cancelling New session returns focus to the card’s + Start session');

    await realClick(pill, '+ Start session (again)');
    await page.waitForSelector('.modal.ns', { state: 'visible', timeout: 10000 });
    const dialogText = await page.locator('.modal.ns').innerText();
    assert(
      dialogText.includes(`Start a session for "${TITLE}"`),
      'the dialog subtitle names the card',
    );
    const homePath = await page.locator('.ns-folder--home .ns-folder__path').textContent();
    assert(norm(homePath) === norm(H), `home is H (got ${homePath})`);
    const others = await page
      .locator('li.ns-folder:not(.ns-folder--home) .ns-folder__path')
      .evaluateAll((els) => els.map((e) => e.textContent));
    assert(
      others.length === 1 && norm(others[0]) === norm(R),
      `exactly R is attached (got ${JSON.stringify(others)})`,
    );
    assert(
      await page.locator('.modal.ns [aria-label="Project: RMB"]').isVisible(),
      'the project chip is RMB',
    );
    const before2 = await page.evaluate(() => window.__sessions.map((s) => s.id));
    const start = page.locator('.ns__foot .btn--primary', { hasText: 'Start session' });
    await page.waitForFunction(
      () => !document.querySelector('.ns__foot .btn--primary')?.disabled,
      null,
      { timeout: 10000 },
    );
    await realClick(start, 'the dialog’s Start session');
    const s2 = await page
      .waitForFunction(
        (ids) => window.__sessions.find((s) => !ids.includes(s.id)) ?? null,
        before2,
        { timeout: 20000 },
      )
      .then((h) => h.jsonValue());
    assert(s2.cardId === CARD_ID, `the new session is linked to the card (got ${s2.cardId})`);
    assert(
      s2.roots.length === 1 && norm(s2.roots[0]) === norm(R),
      `the new session attaches R (got ${JSON.stringify(s2.roots)})`,
    );
    assert(s2.projectId === P, `the new session is in RMB (got ${s2.projectId})`);
    const S2 = s2.id;
    await rename(S2, 'rmb-second');
    await openBoard();
    await waitRows(
      [`rmb-first, ${label}, running`, `rmb-second, ${label}, running`],
      'two rows in host order',
    );
    log('scenario 2: pill → prefilled dialog, focus return, Start links a second row ✓');

    // ── Scenario 3: keyboard jump, close, no write ──────────────────────────
    const before = readData();
    // Starting S2 auto-switched to it, so S1 goes active first: the row has to CHANGE the session.
    await activateViaSidebar(S1, 'S1');
    await openBoard();
    const title = card.locator('.bcard__title');
    await realClick(title, 'the card title');
    await card.locator('button.bcard__session').nth(1).focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.session--active[data-sessionid="${S2}"]`, { timeout: 10000 });
    await page.waitForSelector('.board', { state: 'detached', timeout: 10000 });
    await assertOnlyActive(S2, 'Enter on S2’s row');
    // The mouse jump is proven here, while S1 still exists: once S1 is gone S2 is H's only session,
    // and H's board is only on screen while an H session is active (spec L7), so no later click
    // could CHANGE the active session.
    await activateViaSidebar(S1, 'S1');
    await openBoard();
    await realClick(card.locator('button.bcard__session').nth(1), 'the linked row for S2');
    await page.waitForSelector(`.session--active[data-sessionid="${S2}"]`, { timeout: 10000 });
    await page.waitForSelector('.board', { state: 'detached', timeout: 10000 });
    await assertOnlyActive(S2, 'a mouse click on S2’s row');
    await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), S1);
    await page.waitForFunction((id) => !window.__sessions.some((s) => s.id === id), S1, {
      timeout: 15000,
    });
    await openBoard();
    await waitRows([`rmb-second, ${label}, running`], 'the closed session left the card');
    await page.waitForTimeout(1500);
    assert(
      JSON.stringify(readData()) === JSON.stringify(before),
      'activating and closing sessions never writes board.json',
    );
    log('scenario 3: Enter and a row click jump, a closed session drops its row, no write ✓');

    // ── Scenario 4: a session whose folders exclude H is not listed ─────────
    const S3 = await openSession(page, { path: R, cardId: CARD_ID });
    await rename(S3, 'other-home');
    await page.waitForFunction(
      (id) => window.__sessions.find((s) => s.id === id)?.name === 'other-home',
      S3,
    );
    // The board is the ACTIVE session's home (spec L7): with S3 (home R) active it is R's board,
    // so H's board is only reachable by making an H session active.
    await activateViaSidebar(S2, 'S2');
    await openBoard();
    await waitRows([`rmb-second, ${label}, running`], 'H’s board does not list S3');
    log('scenario 4: another home is not listed ✓');

    // ── Scenario 5: drag from the pill; the ticket survives an app write ────
    await openBoard();
    const pillBox = await pill.boundingBox();
    const wishBox = await column('Wish list').boundingBox();
    assert(pillBox && wishBox, 'the pill and the Wish list column have boxes');
    const from = { x: pillBox.x + pillBox.width / 2, y: pillBox.y + pillBox.height / 2 };
    const to = { x: wishBox.x + wishBox.width / 2, y: wishBox.y + wishBox.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * i) / 20,
        from.y + ((to.y - from.y) * i) / 20,
      );
    }
    await page.mouse.up();
    const mouseSaved = await savedStage('wishlist');
    assert(
      mouseSaved.stage === 'wishlist',
      `a mouse drag from the pill saved the move (got ${mouseSaved.stage})`,
    );
    assert(
      (await page.locator('.modal.ns').count()) === 0,
      'a mouse drag from the pill opens no New session dialog',
    );

    const dropped = await page.evaluate((t) => {
      const c = [...document.querySelectorAll('.bcard')].find((el) => el.textContent.includes(t));
      const from = c?.querySelector('.bcard__start');
      const col = [...document.querySelectorAll('.bcol')].find(
        (el) => el.querySelector('.bcol__title')?.textContent === 'Planning',
      );
      if (!from || !col) return false;
      const dt = new DataTransfer();
      const fire = (el, type) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      fire(from, 'dragstart');
      fire(col, 'dragover');
      fire(col, 'drop');
      fire(from, 'dragend');
      return true;
    }, TITLE);
    assert(dropped, 'the pill and the Planning column exist for the drag');
    await page.waitForFunction(
      (t) =>
        [...document.querySelectorAll('.bcol')]
          .find((el) => el.querySelector('.bcol__title')?.textContent === 'Planning')
          ?.textContent.includes(t),
      TITLE,
      { timeout: 5000 },
    );
    const saved = await savedStage('planning');
    assert(saved.stage === 'planning', `board.json saved the move (got ${saved.stage})`);
    assert(
      JSON.stringify(saved.ticket) === JSON.stringify(TICKET),
      `the app write kept the ticket (got ${JSON.stringify(saved.ticket)})`,
    );
    log('scenario 5: mouse and synthesized drags from the pill move the card; ticket kept ✓');
    passed = true;
  } finally {
    // The sessions' shells run with H as their cwd, which pins it on Windows until the app is gone.
    await closeApp(app, page);
    for (const dir of [H, R]) {
      // On a failure path, a leftover temp dir must not mask the assertion that failed.
      await removeDir(dir).catch((e) => {
        if (passed) throw e;
      });
    }
  }
});
