/**
 * mf-live-edits end-to-end proof (docs/plans/2026-09-23-mf-live-edits.plan.md Slice 5, spec §7).
 * A fake claude (`fixtures/fake-claude.mjs` behind a temp `claude.cmd`) prints a per-process
 * LAUNCH nonce, its argv and cwd, and echoes every submitted line. Every banner action is a real,
 * hit-tested click; folder deletes go through the harness `removeDir`.
 *
 *   E1/E4  add a folder → banner within 1 s, no respawn; Run /add-dir types it unquoted; the
 *          banner goes. A double click and a doubled post type the line exactly once.
 *   E3     while the fake streams, Run /add-dir is disabled and a direct post is refused `busy`
 *          with nothing typed; once idle, the click delivers.
 *   removed  a removed folder claude still sees reads "can still see", Restart only; an unseen
 *          folder deleted from disk drops out of the banner.
 *   E7     Restart claude → focus on Cancel → Restart: exactly one new launch, carrying every
 *          folder; the old child's exit tears nothing down.
 *   AC-10  × dismisses; a later add shows only the new folder.
 *   E2     a shell session never shows the banner.
 *   live   Files and Search follow an attached folder with no respawn.
 *   E5/E6  relaunch with the home renamed away: "Can't start", the 12d state, no spawn (host log
 *          included, autoRelaunchStale on); the home returns → "Session not running", still no spawn.
 *   Locate the home goes again; Locate… picks P → home P, Relaunch focused, spawns in P.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assert,
  closeApp,
  launchApp,
  makeLog,
  openSession,
  REPO,
  removeDir,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

const NAME = 'mf-live-edits';
const log = makeLog(NAME);

if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only (non-win32 platform)`);
  process.exit(0);
}

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-mle-'));
const work = mkdtempSync(join(tmpdir(), 'conduit-mle-work-'));
const dir = (name) => {
  const p = join(work, name);
  mkdirSync(p, { recursive: true });
  return p;
};
const H = dir('H');
const D = dir('D with space');
const E = dir('E');
const F = dir('F');
const G = dir('G');
const K = dir('K');
const X = dir('X');
const P = dir('P');
const S = dir('S');
writeFileSync(join(E, 'needle.txt'), 'needle in E\n');
const bin = dir('bin');
const claudeCmd = join(bin, 'claude.cmd');
writeFileSync(
  claudeCmd,
  `@"${process.execPath}" "${join(REPO, 'test', 'e2e', 'fixtures', 'fake-claude.mjs')}" %*\r\n`,
);
writeFileSync(
  join(userDataDir, 'agents.json'),
  JSON.stringify([
    {
      id: 'fake-claude',
      label: 'claude',
      command: claudeCmd,
      args: [],
      icon: 'terminal',
      color: 'green',
      cwdStrategy: 'workspaceFolder',
    },
  ]),
);

// ── output reading ──────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const osc = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const csi = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const plain = (s) =>
  s
    .replace(osc, '')
    .replace(csi, '')
    .replace(/[\r\n]/g, '');
const raw = (page, sid) => page.evaluate((id) => window.__capBy?.[id] ?? '', sid);

/** Records of `kind` in order, deduped by value — a ConPTY repaint re-prints the screen. */
const records = (text, kind) => {
  const out = [];
  for (const m of text.matchAll(new RegExp(`FAKE-CLAUDE ${kind} (.*?) <<END>>`, 'g'))) {
    out.push(m[1]);
  }
  return out;
};
const launches = async (page, sid) => [...new Set(records(plain(await raw(page, sid)), 'LAUNCH'))];

/** Output after `mark` (a length of the raw capture taken earlier): never replayed history. */
const since = async (page, sid, mark) => plain((await raw(page, sid)).slice(mark));
const mark = (page, sid) => raw(page, sid).then((r) => r.length);

async function until(pred, ms, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** The lines the fake received since `from`, deduped in order. */
const gotSince = async (page, sid, from) => [
  ...new Set(records(await since(page, sid, from), 'GOT')),
];

// ── host helpers ────────────────────────────────────────────────────────────

const sessionOf = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id) ?? null, sid);

function request(page, msg, types) {
  return page.evaluate(
    ({ msg, types }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`no ${types.join('|')} reply to ${msg.type}`));
        }, 15000);
        const off = window.agentDeck.subscribe((m) => {
          if (!types.includes(m.type) || m.requestId !== msg.requestId) return;
          clearTimeout(timer);
          off();
          resolve(m);
        });
        window.agentDeck.post(msg);
      }),
    { msg, types },
  );
}

let reqSeq = 9000;
const addRoot = async (page, sid, path) => {
  const r = await request(
    page,
    { type: 'session:addRoot', sessionId: sid, path, requestId: ++reqSeq },
    ['session:opResult'],
  );
  assert(r.ok, `addRoot ${path} → ${JSON.stringify(r)}`);
};
const type = (page, sid, data) =>
  page.evaluate(
    ({ id, d }) => window.agentDeck.post({ type: 'term:input', sessionId: id, data: d }),
    {
      id: sid,
      d: data,
    },
  );

async function renameAway(from, to) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code) || Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** The window is hidden, so OS focus never arrives: drive the host's own focus handler. */
const focusWindow = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.emit('focus');
  });

const banner = (page) => page.locator('.termhost:visible .scope-banner');
const bannerButton = (page, name) =>
  page.locator('.termhost:visible .scope-banner button', { hasText: new RegExp(`^${name}$`) });

/** The message's first line and its optional second line, as the user reads them. */
const bannerLines = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('.termhost .scope-banner__msg')].find(
      (m) => m.offsetParent !== null,
    );
    if (!el) return null;
    const second = el.querySelector('.scope-banner__second')?.textContent ?? null;
    const first = [...el.childNodes]
      .filter((n) => !(n instanceof Element && n.classList.contains('scope-banner__second')))
      .map((n) => n.textContent)
      .join('');
    return { first, second };
  });

async function waitBannerText(page, want, ms, what, second = null) {
  const ok = await until(
    async () => {
      const l = await bannerLines(page);
      return l?.first === want && l.second === second;
    },
    ms,
    50,
  );
  const got = await bannerLines(page);
  assert(
    ok,
    `${what}: banner should read ${JSON.stringify({ first: want, second })}, got ${JSON.stringify(got)}`,
  );
}

async function waitBannerGone(page, what) {
  const ok = await banner(page)
    .waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  assert(ok, `${what}: the banner should be gone`);
}

// ── phases ──────────────────────────────────────────────────────────────────

async function phaseAddAndRun({ page, sid }) {
  const from = await mark(page, sid);
  const t0 = Date.now();
  await addRoot(page, sid, D);
  await waitBannerText(page, `claude can't see ${basename(D)} yet`, 1000, 'E1');
  log(`E1 banner in ${Date.now() - t0} ms`);
  assert((await launches(page, sid)).length === 1, 'E1: the folder add spawned nothing new');

  // A double click lands its second click on the now-disabled button: one line, not two.
  await bannerButton(page, 'Run /add-dir').dblclick();
  const line = `/add-dir ${D}`;
  assert(
    await until(async () => (await gotSince(page, sid, from)).includes(line), 5000),
    `E4: the fake got ${JSON.stringify(line)} (got ${JSON.stringify(await gotSince(page, sid, from))})`,
  );
  await waitBannerGone(page, 'E4');
  await page.waitForTimeout(500);
  const got = records(await since(page, sid, from), 'GOT').filter((l) => l === line);
  const unique = await gotSince(page, sid, from);
  assert(
    JSON.stringify(unique) === JSON.stringify([line]),
    `E4: exactly one unquoted /add-dir line, got ${JSON.stringify(unique)} (${got.length} renders)`,
  );
  log('E1/E4: banner, one unquoted /add-dir, banner gone ✓');

  // A doubled post with a fast-replying agent: the latch lets exactly one through.
  const fromX = await mark(page, sid);
  await addRoot(page, sid, X);
  await waitBannerText(page, `claude can't see ${basename(X)} yet`, 2000, 'double post');
  const [a, b] = await page.evaluate(
    (id) =>
      Promise.all(
        [9101, 9102].map(
          (requestId) =>
            new Promise((resolve) => {
              const off = window.agentDeck.subscribe((m) => {
                if (m.type !== 'agentScope:result' || m.requestId !== requestId) return;
                off();
                resolve(m);
              });
              window.agentDeck.post({ type: 'session:addDirsToAgent', sessionId: id, requestId });
            }),
        ),
      ),
    sid,
  );
  assert(
    a.ok === true && b.ok === false && b.reason === 'inFlight',
    `double post: one ok, one inFlight (got ${JSON.stringify([a, b])})`,
  );
  await page.waitForTimeout(800);
  const xLines = (await gotSince(page, sid, fromX)).filter((l) => l === `/add-dir ${X}`);
  const xRenders = records(await since(page, sid, fromX), 'GOT').filter((l) =>
    l.startsWith('/add-dir'),
  );
  assert(
    xLines.length === 1 && new Set(xRenders).size === 1,
    `double post: /add-dir X typed once (got ${JSON.stringify(xRenders)})`,
  );
  log('double post → one delivery, one inFlight ✓');
}

async function phaseBusy({ page, sid }) {
  const from = await mark(page, sid);
  await type(page, sid, 'work\r');
  assert(
    await until(async () => (await sessionOf(page, sid))?.busy === true, 3000),
    'E3: the fake became busy',
  );
  await addRoot(page, sid, E);
  await waitBannerText(page, `claude can't see ${basename(E)} yet`, 2000, 'E3');
  const run = bannerButton(page, 'Run /add-dir');
  assert(await run.isDisabled(), 'E3: Run /add-dir disabled while busy');
  assert(
    (await run.getAttribute('title')) === "claude is working — try again when it's idle",
    'E3: busy title',
  );
  const r = await request(
    page,
    { type: 'session:addDirsToAgent', sessionId: sid, requestId: ++reqSeq },
    ['agentScope:result'],
  );
  assert(r.ok === false && r.reason === 'busy', `E3: host refuses busy (got ${JSON.stringify(r)})`);
  assert(
    !(await gotSince(page, sid, from)).some((l) => l.startsWith('/add-dir')),
    'E3: nothing typed while busy',
  );
  assert(
    await until(async () => (await sessionOf(page, sid))?.busy !== true, 10000),
    'E3: the fake went idle',
  );
  await run.waitFor({ state: 'visible' });
  assert(
    await until(async () => !(await run.isDisabled()), 3000),
    'E3: Run /add-dir enabled once idle',
  );
  await run.click();
  assert(
    await until(async () => (await gotSince(page, sid, from)).includes(`/add-dir ${E}`), 5000),
    'E3: delivered after idle',
  );
  await waitBannerGone(page, 'E3');
  log('E3: disabled + refused while busy, delivered once idle ✓');
}

async function phaseRemovedAndMissing({ app, page, sid }) {
  await request(
    page,
    { type: 'session:removeRoot', sessionId: sid, path: X, requestId: ++reqSeq },
    ['session:opResult'],
  );
  await waitBannerText(
    page,
    `claude can still see ${basename(X)} until it restarts`,
    2000,
    'removed',
  );
  assert(
    (await bannerButton(page, 'Run /add-dir').count()) === 0,
    'removed: no Run /add-dir for a folder claude still sees',
  );
  assert(
    (await bannerButton(page, 'Restart claude').getAttribute('class')) === 'btn btn--warn',
    'removed: Restart claude is the primary',
  );
  log('removed folder → "can still see", Restart only ✓');

  const Y = dir('Y');
  await addRoot(page, sid, Y);
  await waitBannerText(
    page,
    `claude can't see ${basename(Y)} yet`,
    2000,
    'both',
    `It can still see ${basename(X)} until it restarts.`,
  );
  await removeDir(Y);
  await focusWindow(app);
  await waitBannerText(
    page,
    `claude can still see ${basename(X)} until it restarts`,
    8000,
    'an unseen folder that goes missing drops out',
  );
  log('unseen folder deleted → drops out of the banner ✓');
}

async function phaseRestart({ page, sid }) {
  await addRoot(page, sid, F);
  await waitBannerText(
    page,
    `claude can't see ${basename(F)} yet`,
    2000,
    'E7',
    `It can still see ${basename(X)} until it restarts.`,
  );
  const before = await launches(page, sid);
  await bannerButton(page, 'Restart claude').click();
  const active = await page.evaluate(() => document.activeElement?.textContent ?? null);
  assert(active === 'Cancel', `E7: focus lands on Cancel (got ${JSON.stringify(active)})`);
  const from = await mark(page, sid);
  await bannerButton(page, 'Restart').click();
  assert(
    await until(async () => (await launches(page, sid)).length === before.length + 1, 10000),
    `E7: one new launch (got ${JSON.stringify(await launches(page, sid))})`,
  );
  const after = await since(page, sid, from);
  const args = records(after, 'ARGS');
  const argv = JSON.parse(args[args.length - 1]);
  for (const f of [D, E, F]) {
    const i = argv.indexOf(f);
    assert(i > 0 && argv[i - 1] === '--add-dir', `E7: --add-dir ${f} in ${JSON.stringify(argv)}`);
  }
  assert(!argv.includes(X), `E7: the removed X is not passed (${JSON.stringify(argv)})`);
  assert(
    !argv.includes(join(work, 'Y')),
    `E7: the missing Y is not passed (${JSON.stringify(argv)})`,
  );
  assert(after.includes('— session relaunched —'), 'E7: the relaunch marker is shown');
  await waitBannerGone(page, 'E7');
  await page.waitForTimeout(3000);
  assert(
    (await launches(page, sid)).length === before.length + 1,
    'E7: still exactly one new launch',
  );
  assert((await sessionOf(page, sid))?.status === 'running', 'E7: still running 3 s later (R1)');
  const fromPing = await mark(page, sid);
  await type(page, sid, 'ping\r');
  assert(
    await until(async () => (await gotSince(page, sid, fromPing)).includes('ping'), 5000),
    'E7: the new child answers',
  );
  log('E7: Cancel focused, one respawn with D/E/F, R1 held ✓');
}

async function phaseDismiss({ page, sid }) {
  await addRoot(page, sid, G);
  await waitBannerText(page, `claude can't see ${basename(G)} yet`, 2000, 'AC-10');
  await page.locator('.termhost:visible .scope-banner__close').click();
  await waitBannerGone(page, 'AC-10 dismiss');
  await addRoot(page, sid, K);
  await waitBannerText(page, `claude can't see ${basename(K)} yet`, 2000, 'AC-10 new folder only');
  await bannerButton(page, 'Run /add-dir').click();
  await waitBannerGone(page, 'AC-10 run');
  log('AC-10: dismissed; the next add shows only K ✓');
}

async function phaseShell({ page }) {
  const shellSid = await openSession(page, { path: S, agentId: 'shell:cmd' });
  await addRoot(page, shellSid, P);
  await page.waitForTimeout(1500);
  const n = await page.locator('.termhost:visible .scope-banner').count();
  assert(n === 0, `E2: no banner on a shell (got ${n})`);
  await request(
    page,
    { type: 'session:removeRoot', sessionId: shellSid, path: P, requestId: ++reqSeq },
    ['session:opResult'],
  );
  await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), shellSid);
  log('E2: shell gets no banner ✓');
}

async function phaseLive({ page, sid }) {
  await page.locator(`.session[data-sessionid="${sid}"]`).click();
  const before = (await launches(page, sid)).length;
  await page.locator('.rtab', { hasText: 'Files' }).click();
  const bar = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.files-section > .files__bar .files__root-name')].some(
          (b) => b.textContent === 'E',
        ),
      null,
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(bar, 'live: the Files tab lists E');
  const input = page.locator('.search__inputbox textarea');
  await input.click();
  await input.fill('needle');
  const found = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.searchfolder .searchfolder__name')].some(
          (h) => h.textContent === 'E',
        ),
      null,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(found, 'live: Search finds needle under E');
  await input.fill('');
  assert((await launches(page, sid)).length === before, 'live: no respawn');
  log('live: Files + Search follow E, no respawn ✓');
}

const logRecordsSince = (t0, sid) => {
  const dir = join(tmpdir(), 'conduit-e2e-logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^conduit-.*\.log$/.test(f))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((r) => r.ts >= t0 && r.data?.sessionId === sid);
};

async function phaseMissingHome({ app, page, sid }) {
  const t0 = Date.now();
  const cardState = page.locator(`.session[data-sessionid="${sid}"] .session__state`);
  await page.locator(`.session[data-sessionid="${sid}"]`).click();
  assert(
    await until(
      async () => (await cardState.textContent().catch(() => '')) === "Can't start",
      15000,
    ),
    `E5: the card says Can't start (got ${JSON.stringify(await cardState.textContent().catch(() => null))})`,
  );
  const title = await page.locator('.stale .stale__title').textContent();
  const path = await page.locator('.stale .stale__path').textContent();
  assert(title === 'Home folder not found', `E5: centre title (got ${JSON.stringify(title)})`);
  assert(path === H, `E5: centre path (got ${JSON.stringify(path)})`);
  const firstRoot = basename(D);
  assert(
    (await page.locator('.stale button', { hasText: `Use ${firstRoot} as home` }).count()) === 1,
    `E5: Use ${firstRoot} as home is offered`,
  );
  const launchesBefore = (await launches(page, sid)).length;
  await page.waitForTimeout(3000);
  assert((await launches(page, sid)).length === launchesBefore, 'E5: no fake launch');
  assert((await sessionOf(page, sid))?.status !== 'running', 'E5: the session is not running');
  const spawned = logRecordsSince(t0, sid).filter((r) => r.scope === 'pty' && r.msg === 'spawn');
  assert(spawned.length === 0, `E5: no pty spawn in the host log (got ${JSON.stringify(spawned)})`);
  log("E5: Can't start + 12d, no spawn (autoRelaunchStale on) ✓");

  await renameAway(`${H}.gone`, H);
  await focusWindow(app);
  assert(
    await until(
      async () =>
        (await page
          .locator('.stale .stale__title')
          .textContent()
          .catch(() => '')) === 'Session not running',
      6000,
    ),
    'E6: the centre reverts to Session not running within 6 s',
  );
  assert(
    (await page.locator('.stale button', { hasText: '↻ Relaunch' }).count()) === 1,
    'E6: Relaunch offered',
  );
  assert((await cardState.textContent()) === 'Stale', 'E6: the card says Stale');
  await page.waitForTimeout(1000);
  assert((await launches(page, sid)).length === launchesBefore, 'E6: still no launch');
  log('E6: home back → Session not running, no spawn ✓');
}

async function phaseLocate({ app, page, sid }) {
  await renameAway(H, `${H}.gone2`);
  await focusWindow(app);
  assert(
    await until(
      async () =>
        (await page
          .locator('.stale .stale__title')
          .textContent()
          .catch(() => '')) === 'Home folder not found',
      12000,
    ),
    'Locate: the home is missing again',
  );
  await app.evaluate((_e, p) => global.__pickDirHook.queue([p]), P);
  const from = await mark(page, sid);
  await page.locator('.stale button', { hasText: 'Locate…' }).click();
  assert(
    await until(async () => (await sessionOf(page, sid))?.home === P, 10000),
    `Locate: home is P (got ${JSON.stringify((await sessionOf(page, sid))?.home)})`,
  );
  const relaunch = page.locator('.stale button', { hasText: '↻ Relaunch' });
  await relaunch.waitFor({ state: 'visible', timeout: 5000 });
  assert(
    await until(
      async () =>
        (await page.evaluate(() => document.activeElement?.textContent ?? '')) === '↻ Relaunch',
      2000,
    ),
    'Locate: Relaunch is focused',
  );
  await relaunch.click();
  assert(
    await until(async () => records(await since(page, sid, from), 'CWD').includes(P), 15000),
    `Locate: the fake starts in P (got ${JSON.stringify(records(await since(page, sid, from), 'CWD'))})`,
  );
  log('Locate: home P, Relaunch focused, spawns in P ✓');
}

// ── run ─────────────────────────────────────────────────────────────────────

let code = 0;
let launched = null;
try {
  launched = await launchApp({ userDataDir });
  let { app, page } = launched;
  await tapBridge(page);
  const sid = await openSession(page, { path: H, agentId: 'fake-claude' });
  assert(
    await until(async () => (await launches(page, sid)).length === 1, 20000),
    'the fake claude launched once',
  );
  const ctx = { app, page, sid };
  await phaseAddAndRun(ctx);
  await phaseBusy(ctx);
  await phaseRemovedAndMissing(ctx);
  await phaseRestart(ctx);
  await phaseDismiss(ctx);
  await phaseShell(ctx);
  await phaseLive(ctx);

  await closeApp(app, page);
  launched = null;
  const settingsPath = join(userDataDir, 'settings.json');
  const blob = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, 'utf8'))
    : { version: 1, settings: {} };
  blob.settings = { ...blob.settings, autoRelaunchStale: true };
  writeFileSync(settingsPath, JSON.stringify(blob));
  await renameAway(H, `${H}.gone`);

  launched = await launchApp({ userDataDir });
  ({ app, page } = launched);
  await tapBridge(page);
  const relaunched = { app, page, sid };
  await phaseMissingHome(relaunched);
  await phaseLocate(relaunched);
  log('PASS ✓');
} catch (e) {
  code = e?.name === 'AssertionError' ? 1 : 2;
  console.error(`[${NAME}] ${code === 1 ? 'FAIL ✗' : 'ERROR:'}`, e?.message || e);
  if (code === 2 && e?.stack) console.error(e.stack);
}
if (launched) {
  try {
    await shutdownApp(launched.app, launched.page);
  } catch {
    /* already gone */
  }
}
// Temp dirs are left to the OS.
process.exit(code);
