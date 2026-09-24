/**
 * New session dialog, end to end (mf-new-session spec §7): detected CLI pills ranked by use,
 * More, folders through the one `folder:pick` seam (`__pickDirHook`), the host-computed
 * "Launches as" preview, the batch-file guard, custom launchers, the board-card prefill, and the
 * agents.json alias across a relaunch.
 *
 * Standalone launch (not `runScenario`) because it seeds userData (repos.json, then agents.json
 * for the second launch) and PATH: a stub dir holding `claude.cmd` / `codex.cmd`, System32, and
 * git's directory (the probe's branch comes from real git). The stubs echo their argv, so the
 * terminal shows exactly what `term:start` spawned.
 *
 * It also carries what the retired new-session-browse-pinned.e2e.mjs proved for the old dialog:
 * with a long recents list, Browse… is reachable without scrolling, and the Add row does not
 * move when the folder list scrolls.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assert,
  closeApp,
  launchApp,
  makeLog,
  openSession,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

const log = makeLog('new-session-folders');

if (process.platform !== 'win32') {
  console.log('[new-session-folders] SKIP — suite is Windows-only');
  process.exit(0);
}

// ── fixture ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'mfns-e2e-'));
const stubDir = join(root, 'bin');
mkdirSync(stubDir);
// STUB-RUN names the app launch that spawned the stub: a relaunched session replays the
// previous launch's output as scrollback, so its STUB-ARGS alone prove nothing (QA F2).
for (const name of ['claude', 'codex']) {
  writeFileSync(
    join(stubDir, `${name}.cmd`),
    '@echo off\r\necho STUB-RUN:%STUB_RUN%\r\necho STUB-ARGS:%*\r\nping -n 60 127.0.0.1 >nul\r\n',
  );
}
const A = join(root, 'room-message-bus');
const B = join(root, 'bitbucket-ci-image');
const C = join(root, 'x&y');
for (const d of [A, B, C]) mkdirSync(d);
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd });
git(A, 'init', '-q', '-b', 'main');
git(A, 'commit', '-q', '--allow-empty', '-m', 'init');
const CARD = { id: 'c-rmb', title: 'Move RMB to CI' };
mkdirSync(join(A, '.conduit'));
writeFileSync(
  join(A, '.conduit', 'board.json'),
  JSON.stringify({
    conduit: 1,
    kind: 'board',
    updatedAt: Date.now(),
    data: {
      version: 1,
      cards: [{ ...CARD, notes: '', stage: 'wishlist', createdAt: 1, updatedAt: 1 }],
    },
  }),
);

// Recents long enough that a list-bound Browse… would have to be scrolled to (the retired
// scenario's subject). The host prunes recents whose folder is gone, so each is real.
const recents = Array.from({ length: 14 }, (_, i) => {
  const path = join(root, `recent-${i}`);
  mkdirSync(path);
  return { path, name: `recent-${i}`, lastOpened: 100 - i };
});
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-ud-'));
writeFileSync(join(userDataDir, 'repos.json'), JSON.stringify({ version: 1, repos: recents }));

const gitDir = dirname(
  execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean) ?? '',
);
const sys32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const PATH = [stubDir, sys32, gitDir].join(';');
// Windows env keys are case-insensitive but a spread keeps `Path`; set both to one value.
const env = { PATH, Path: PATH };
const envForRun = (run) => ({ ...env, STUB_RUN: run });

// ── page helpers ────────────────────────────────────────────────────────────

const q = (page, sel) => page.locator(sel);
const pills = (page) => page.$$eval('.ns-launch .ns-pill', (els) => els.map((e) => e.textContent));
const folderNames = (page) =>
  page.$$eval('.ns-folder .ns-folder__name', (els) => els.map((e) => e.textContent));

async function openDialog(page) {
  await page.locator('[aria-label="New session"]').first().click();
  await page.waitForSelector('.modal.ns', { state: 'visible', timeout: 10000 });
  // A menu opened while modal-pop still animates can close itself (learnings, mf-changes fix1).
  await page.waitForFunction(
    () => (document.querySelector('.modal.ns')?.getAnimations({ subtree: true }).length ?? 1) === 0,
    null,
    { timeout: 5000 },
  );
}

async function closeDialog(page) {
  await page.locator('.ns__foot .btn', { hasText: 'Cancel' }).click();
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 5000 });
}

async function clearFolders(page) {
  for (let n = await q(page, '.ns-folder').count(); n > 0; n--) {
    await page.locator('.ns-folder').last().locator('.ns-folder__remove').click();
    await page.waitForFunction((k) => document.querySelectorAll('.ns-folder').length === k - 1, n);
  }
}

async function browseAdd(app, page, paths) {
  await app.evaluate((_e, p) => global.__pickDirHook.queue(p), paths);
  for (const _ of paths) {
    const before = await q(page, '.ns-folder').count();
    await page.locator('.ns-folders__add').click();
    await page.locator('.ns-addmenu__browse').click();
    await page.waitForFunction(
      (k) => document.querySelectorAll('.ns-folder').length === k + 1,
      before,
      { timeout: 8000 },
    );
  }
}

async function pick(page, label) {
  await page.locator('.ns-launch .ns-pill', { hasText: new RegExp(`^${label}$`) }).click();
}

async function waitPreview(page, expected) {
  await page
    .waitForFunction(
      (want) => {
        const el = document.querySelector('.ns-preview:not(.ns-preview--busy)');
        return el?.textContent === want;
      },
      expected,
      { timeout: 10000 },
    )
    .catch(async () => {
      const got = await page.locator('.ns-preview').textContent();
      assert(
        false,
        `"Launches as" should read ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
      );
    });
}

/** Every renderer→host message type the main process received, in order. */
async function spyHostMessages(app) {
  await app.evaluate(({ ipcMain }) => {
    global.__hostMsgs = [];
    ipcMain.on('to-host', (_e, m) => global.__hostMsgs.push(m?.type));
  });
}
const hostMsgs = (app) => app.evaluate(() => global.__hostMsgs);

/** The next `state`'s agent ids (a `ready` forces one). */
const stateAgents = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'state') {
            off();
            resolve(m.agents.map((a) => a.id));
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
  );

async function tapResults(page) {
  await page.evaluate(() => {
    window.__results = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'openRepo:result' || m.type === 'project:created') window.__results.push(m);
    });
  });
}

async function openRepoViaHost(page, path, agentId) {
  return page.evaluate(
    ({ p, a }) =>
      new Promise((resolve) => {
        const requestId = 900000 + Math.floor(Math.random() * 99999);
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'openRepo:result' && m.requestId === requestId) {
            off();
            resolve(m);
          }
        });
        window.agentDeck.post({ type: 'openRepo', path: p, agentId: a, requestId });
      }),
    { p: path, a: agentId },
  );
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, 'g');
const stripAnsi = (s) => s.replace(CSI, '').replace(OSC, '');

/** The STUB-ARGS line printed by a stub spawned in app launch `run`, never an earlier launch's. */
async function waitStubArgs(page, sid, run) {
  const h = await page
    .waitForFunction(
      ({ id, marker }) => {
        const raw = window.__capBy?.[id] ?? '';
        const at = raw.indexOf(marker);
        return at >= 0 && raw.indexOf('STUB-ARGS:', at) >= 0 ? raw.slice(at) : null;
      },
      { id: sid, marker: `STUB-RUN:${run}` },
      { timeout: 30000 },
    )
    .catch(() => null);
  if (!h) {
    const got = stripAnsi(await page.evaluate((id) => window.__capBy?.[id] ?? '', sid));
    assert(
      false,
      `session ${sid}'s terminal never printed STUB-ARGS in launch ${run} (the stub did not run); it shows ${JSON.stringify(got.slice(-300))}`,
    );
  }
  const text = stripAnsi(await h.jsonValue()).replace(/\r?\n/g, '');
  return text.slice(text.indexOf('STUB-ARGS:'));
}

// ── run ─────────────────────────────────────────────────────────────────────

let launched = null;
let code = 0;
try {
  launched = await launchApp({ userDataDir, env: envForRun('first') });
  const { app, page } = launched;
  await tapBridge(page);
  await tapResults(page);
  await spyHostMessages(app);

  // ── Scenario: multi-folder claude session in a project ─────────────────────
  const created = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'project:created' && m.requestId === 4242) {
            off();
            resolve(m.id);
          }
        });
        window.agentDeck.post({ type: 'project:create', name: 'RMB pipeline', requestId: 4242 });
      }),
  );
  log('project created:', created);

  await openDialog(page);
  assert(
    JSON.stringify(await pills(page)) === JSON.stringify(['claude', 'codex', 'Shell']),
    `with only the claude/codex stubs on PATH the row is claude, codex, Shell (got ${await pills(page)})`,
  );
  log('row: claude, codex, Shell ✓ (AC1)');

  // Retired browse-pinned guarantee: 14 recents, and Browse… still sits inside the viewport.
  await page.locator('.ns-folders__add').click();
  await page.waitForSelector('.ns-addmenu', { state: 'visible' });
  const menu = await page.evaluate(() => {
    const browse = document.querySelector('.ns-addmenu__browse')?.getBoundingClientRect();
    return {
      recents: document.querySelectorAll('.ns-addmenu__item').length,
      browseBottom: browse?.bottom ?? Number.POSITIVE_INFINITY,
      viewport: window.innerHeight,
    };
  });
  assert(menu.recents === 10, `Recent lists at most 10 folders (got ${menu.recents})`);
  assert(
    menu.browseBottom <= menu.viewport,
    `Browse… must be on screen without scrolling (bottom ${menu.browseBottom}, viewport ${menu.viewport})`,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ns-addmenu', { state: 'detached' });
  assert(await page.isVisible('.modal.ns'), 'Escape closes the menu first, not the dialog');
  log('Add folder menu: 10 recents, Browse… reachable, Esc closes the menu only ✓');

  await clearFolders(page);
  await browseAdd(app, page, [A, B]);
  assert(
    JSON.stringify(await folderNames(page)) ===
      JSON.stringify(['room-message-bus', 'bitbucket-ci-image']),
    `A then B are listed (got ${await folderNames(page)})`,
  );
  await page.waitForFunction(
    () => document.querySelector('.ns-folder--home .ns-folder__branch')?.textContent === ' · main',
    null,
    { timeout: 10000 },
  );
  const attached = page.locator('.ns-folder').nth(1);
  assert(
    (await attached.locator('.ns-folder__make').innerText()) === 'Make home' &&
      (await attached.locator('.ns-folder__remove').count()) === 1 &&
      (await page.locator('.ns-folder--home .ns-folder__home').innerText()) === 'Home',
    'A is the Home row (with · main); B is attached with Make home and ×',
  );
  log('folders: A Home · main, B attached ✓');

  await pick(page, 'claude');
  await waitPreview(page, `${A}> claude --add-dir ${B}`);
  log('Launches as ✓ (AC4)');

  await page.locator('.ns-chip--none').click();
  await page.locator('.ns-projects [role="menuitemradio"]', { hasText: 'RMB pipeline' }).click();
  assert(
    (await page.locator('.ns-chip__body').getAttribute('aria-label')) === 'Project: RMB pipeline',
    'the chip names the picked project',
  );

  await page.locator('.ns__foot .btn--primary').click();
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10000 });
  const s1 = await page.evaluate(
    () => window.__results.find((m) => m.type === 'openRepo:result')?.sessionId,
  );
  assert(s1, 'openRepo:result carries the new sessionId');
  const s1State = await page
    .waitForFunction((id) => window.__sessions.find((s) => s.id === id) ?? null, s1)
    .then((h) => h.jsonValue());
  assert(
    s1State.home === A &&
      JSON.stringify(s1State.roots) === JSON.stringify([B]) &&
      s1State.projectId === created &&
      s1State.agentId === 'cli:claude',
    `the session has home A, roots [B], the project and cli:claude (got ${JSON.stringify(s1State)})`,
  );
  log('session: home A, roots [B], RMB pipeline, cli:claude ✓ (AC5)');
  const args = await waitStubArgs(page, s1, 'first');
  assert(
    args.startsWith(`STUB-ARGS:--add-dir ${B}`) && args.split('--add-dir').length === 2,
    `the spawned stub got exactly one --add-dir B (got ${JSON.stringify(args.slice(0, 200))})`,
  );
  log('terminal: STUB-ARGS:--add-dir B ✓ (AC4 spawn half)');

  // ── Scenario: Make home ─────────────────────────────────────────────────────
  await openDialog(page);
  assert(
    JSON.stringify(await folderNames(page)) ===
      JSON.stringify(['room-message-bus', 'bitbucket-ci-image']),
    "opening again in the project seeds its last session's folders",
  );
  await page.locator('button[aria-label="Make bitbucket-ci-image home"]').click();
  assert(
    (await page.locator('.ns-folder--home .ns-folder__name').innerText()) === 'bitbucket-ci-image',
    'B is home after Make home',
  );
  await page.waitForFunction(
    (b) =>
      document.querySelector('.ns-preview:not(.ns-preview--busy) .ns-preview__cwd')?.textContent ===
      `${b}>`,
    B,
    { timeout: 10000 },
  );
  log('Make home: B is home, preview cwd follows ✓ (AC6)');
  await closeDialog(page);

  // ── Scenario: More toggles; ranking follows use ────────────────────────────
  for (const agentId of ['cli:codex', 'cli:codex', 'cli:codex', 'cli:claude']) {
    const r = await openRepoViaHost(page, B, agentId);
    assert(r.sessionId, `openRepo ${agentId} should create a session (${JSON.stringify(r)})`);
  }
  const launchersFile = join(userDataDir, 'launchers.json');
  await openDialog(page);
  const ranked = await pills(page);
  assert(
    JSON.stringify(ranked.slice(0, 2)) === JSON.stringify(['codex', 'claude']) &&
      ranked.includes('Shell'),
    `after 3 codex and 2 claude starts the row leads codex, claude, then Shell (got ${ranked})`,
  );
  log('ranking: codex, claude, …, Shell ✓ (AC2)');
  await page.locator('.ns-more').click();
  await page.waitForSelector('.ns-more-menu', { state: 'visible' });
  const more = await page.evaluate(() => {
    const m = document.querySelector('.ns-more-menu')?.getBoundingClientRect();
    const b = document.querySelector('.ns-more')?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.ns-more__item')].map((r) => [
      r.querySelector('.ns-more__label')?.textContent,
      r.querySelector('.ns-more__tag')?.textContent,
    ]);
    const items = [...document.querySelectorAll('.ns-more-menu [role^="menuitem"]')];
    return {
      dx: Math.abs((m?.right ?? 0) - (b?.right ?? 1e9)),
      head: document.querySelector('.ns-more__head')?.textContent,
      rows,
      last: items.at(-1)?.textContent,
    };
  });
  assert(more.head === 'Found on this machine', `More's header (got ${more.head})`);
  assert(more.dx <= 1, `More's right edge within 1px of the button's (off by ${more.dx}px)`);
  assert(
    more.rows.length > 0 &&
      more.rows.every(([l, t]) => l && ['PATH', 'shell', 'config', 'custom'].includes(t)),
    `every More row is labelled and tagged (got ${JSON.stringify(more.rows)})`,
  );
  assert(more.last === '+ Custom command…', `More ends with + Custom command… (got ${more.last})`);
  await page.locator('.ns-more').click();
  await page.waitForSelector('.ns-more-menu', { state: 'detached', timeout: 3000 });
  log('More: header, tags, custom row, right-aligned, second click closes ✓ (AC3)');

  // ── Scenario: batch-file guard ──────────────────────────────────────────────
  await clearFolders(page);
  await browseAdd(app, page, [A, C]);
  await pick(page, 'claude');
  await page.waitForFunction(
    () => document.querySelector('.ns__reason')?.textContent?.includes('x&y'),
    null,
    { timeout: 10000 },
  );
  const reason = await page.locator('.ns__reason').innerText();
  assert(
    reason ===
      'claude is a .cmd shim and can\'t take "x&y" (contains &). Rename the folder or use an .exe install.',
    `the guard names the folder and the character (got ${JSON.stringify(reason)})`,
  );
  assert(await page.locator('.ns__foot .btn--primary').isDisabled(), 'Start is disabled');
  const sessionsBefore = await page.evaluate(() => window.__sessions.length);
  const opensBefore = (await hostMsgs(app)).filter((t) => t === 'openRepo').length;
  await page.locator('.ns__foot .btn--primary').click({ force: true });
  await page.focus('.modal.ns');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const opensAfter = (await hostMsgs(app)).filter((t) => t === 'openRepo').length;
  assert(opensAfter === opensBefore, `no openRepo is posted (${opensBefore} → ${opensAfter})`);
  assert(
    (await page.evaluate(() => window.__sessions.length)) === sessionsBefore,
    'and no session appears',
  );
  assert(await page.isVisible('.modal.ns'), 'the dialog stays open');
  log('batch-file guard: Start disabled, nothing posted ✓ (AC8)');

  // Retired browse-pinned guarantee, second half: the list scrolls, the Add row stays put.
  const extra = recents.slice(0, 8).map((r) => r.path);
  await browseAdd(app, page, extra);
  const pinned = await page.evaluate(() => {
    const list = document.querySelector('.ns-folders');
    const add = document.querySelector('.ns-folders__add');
    const before = add?.getBoundingClientRect().top;
    if (list) list.scrollTop = list.scrollHeight;
    return {
      overflow: (list?.scrollHeight ?? 0) - (list?.clientHeight ?? 0),
      scrolled: list?.scrollTop ?? 0,
      moved: (add?.getBoundingClientRect().top ?? 0) - (before ?? 0),
      inList: !!list?.contains(add),
    };
  });
  assert(
    pinned.overflow > 0 && pinned.scrolled > 0,
    `ten folders overflow and scroll the list (${JSON.stringify(pinned)})`,
  );
  assert(
    !pinned.inList && pinned.moved === 0,
    `+ Add folder… stays pinned under the list (${JSON.stringify(pinned)})`,
  );
  log('folders list scrolls inside its bound; Add stays pinned ✓');
  await closeDialog(page);

  // ── Scenario: custom command ────────────────────────────────────────────────
  await openDialog(page);
  await page.locator('.ns-more').click();
  await page.locator('.ns-more__custom').click();
  await page.locator('input[aria-label="Command"]').fill('codex --x');
  await page.locator('.ns-custom .btn--primary', { hasText: 'Add' }).click();
  await page.waitForSelector('.ns-custom', { state: 'detached', timeout: 8000 });
  const selected = await page.locator('.ns-pill[aria-checked="true"]').innerText();
  assert(selected === 'codex (2)', `the new launcher is the selected extra pill (got ${selected})`);
  const withCustom = await stateAgents(page);
  assert(
    withCustom.some((id) => id.startsWith('custom:')),
    `state.agents gains the custom launcher (got ${withCustom})`,
  );
  await closeDialog(page);
  log('custom command: codex (2) selected ✓');

  // ── Scenario: board card prefill ────────────────────────────────────────────
  const boardHost = await openSession(page, { path: A, roots: [B] });
  log('board host session:', boardHost);
  await page.locator('.viewswitch__btn[title="Feature Board"]').click();
  const card = page.locator('.bcard', { hasText: CARD.title }).first();
  await card.waitFor({ state: 'visible', timeout: 15000 });
  await card.click({ button: 'right' });
  await page.locator('.ctxmenu__item', { hasText: 'Start session for this card' }).click();
  await page.waitForSelector('.modal.ns', { state: 'visible', timeout: 10000 });
  const sub = await page.locator('.modal.ns .modal__sub').innerText();
  assert(sub === `Start a session for "${CARD.title}"`, `the subtitle names the card (got ${sub})`);
  assert(
    JSON.stringify(await folderNames(page)) ===
      JSON.stringify(['room-message-bus', 'bitbucket-ci-image']),
    `the card prefill carries the active session's folders (got ${await folderNames(page)})`,
  );
  const resultsBefore = await page.evaluate(() => window.__results.length);
  await page.waitForFunction(
    () => !document.querySelector('.ns__foot .btn--primary')?.disabled,
    null,
    { timeout: 10000 },
  );
  await page.locator('.ns__foot .btn--primary').click();
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10000 });
  const cardSid = await page
    .waitForFunction(
      (n) => window.__results.slice(n).find((m) => m.type === 'openRepo:result')?.sessionId ?? null,
      resultsBefore,
    )
    .then((h) => h.jsonValue());
  const cardSession = await page
    .waitForFunction((id) => window.__sessions.find((s) => s.id === id) ?? null, cardSid)
    .then((h) => h.jsonValue());
  assert(cardSession.cardId === CARD.id, `Start stamps the card id (got ${cardSession.cardId})`);
  log('board card prefill: subtitle, folders, cardId ✓ (AC7)');

  await closeApp(app, page);
  launched = null;
  const launchers = JSON.parse(readFileSync(launchersFile, 'utf8'));
  const custom = launchers.custom.find((d) => d.id.startsWith('custom:'));
  assert(
    custom?.label === 'codex (2)' && JSON.stringify(custom.args) === JSON.stringify(['--x']),
    `launchers.json keeps the custom launcher (got ${JSON.stringify(launchers.custom)})`,
  );
  assert(
    launchers.usage['cli:codex']?.count === 3 && launchers.usage['cli:claude']?.count >= 2,
    `launchers.json keeps the use counts (got ${JSON.stringify(launchers.usage)})`,
  );
  log('launchers.json: custom launcher + usage persisted ✓');

  // ── Scenario: agents.json alias (relaunch) ──────────────────────────────────
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify([
      {
        id: 'my-claude',
        label: 'my-claude',
        command: 'claude',
        args: [],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
    ]),
  );
  launched = await launchApp({ userDataDir, env: envForRun('second') });
  const second = launched;
  await tapBridge(second.page);
  const agents = await stateAgents(second.page);
  assert(
    agents.includes('my-claude') && !agents.includes('cli:claude'),
    `agents.json's my-claude hides cli:claude (got ${agents})`,
  );
  const restored = await second.page
    .waitForFunction((id) => window.__sessions.find((s) => s.id === id) ?? null, s1, {
      timeout: 30000,
    })
    .then((h) => h.jsonValue());
  assert(
    restored.agentId === 'cli:claude',
    `the persisted session keeps cli:claude (got ${restored.agentId})`,
  );
  await openDialog(second.page);
  const aliasRow = await pills(second.page);
  assert(
    aliasRow.includes('my-claude') && !aliasRow.includes('claude'),
    `the row shows my-claude instead of claude (got ${aliasRow})`,
  );
  await pick(second.page, 'my-claude');
  const wantTitle = join(stubDir, 'claude.cmd');
  await second.page
    .waitForFunction(
      (want) =>
        document.querySelector('.ns-preview:not(.ns-preview--busy)')?.getAttribute('title') ===
        want,
      wantTitle,
      { timeout: 10000 },
    )
    .catch(() => {});
  const resolvedTitle = await second.page.locator('.ns-preview').getAttribute('title');
  assert(
    resolvedTitle === wantTitle,
    `my-claude's preview names the command term:start will spawn (got ${JSON.stringify(resolvedTitle)})`,
  );
  await closeDialog(second.page);
  await second.page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), s1);
  await second.page.locator(`.session[data-sessionid="${s1}"]`).click();
  const aliasArgs = await waitStubArgs(second.page, s1, 'second');
  assert(
    aliasArgs.startsWith(`STUB-ARGS:--add-dir ${B}`),
    `the cli:claude session launches my-claude's claude with its root (got ${JSON.stringify(aliasArgs.slice(0, 200))})`,
  );
  log('alias: my-claude shown, persisted cli:claude session launches it ✓ (AC9)');

  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[new-session-folders] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}

try {
  await shutdownApp(launched?.app, launched?.page);
} catch {
  /* already gone */
}
for (const dir of [root, userDataDir]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    log('could not remove', dir, e?.code ?? e);
  }
}
process.exit(code);
