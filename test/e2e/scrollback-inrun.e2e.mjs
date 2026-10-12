/**
 * History survives a ↻ Restart inside one app run, and a renderer reload over mixed sizes.
 *
 * 1. Restart: an agent session (cmd.exe /k, so `exit` leaves it on the "Process exited" card
 *    rather than auto-closing like a plain shell) prints a run, exits, the window narrows, and
 *    the UI's Restart (`session:restart`) remounts the pane over a new child. That pane must show
 *    the previous run at once — every cold start replays the in-memory ring.
 * 2. Reload: the restarted child prints a second run, so the ring now spans two sizes plus the
 *    live run. `webContents.reload()` (what renderer auto-recovery does) attaches a fresh pane to
 *    the live PTY; the attach replay must write each segment at its own size, so every line of
 *    every run comes back whole and none merge.
 *
 * Every check is collected and reported together, so one failure doesn't hide the next.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  assert,
  assertFontsHeldBack,
  assertFontsPending,
  finishScenario,
  holdBackWebFonts,
  launchElectron,
  logicalLines,
  makeLog,
  openSession,
  probeTerminalSize,
  profileDir,
  REPO,
  shutdownApp,
  tapBridge,
  typeLine,
  waitForOutput,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[scrollback-inrun] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('scrollback-inrun');
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const userDataDir = profileDir('sbi');
const AGENT = 'inrun-agent';
const MARKER = '— session relaunched —';
const RELOADS = 4;
const LONG = `R1-LONG-${'0123456789'.repeat(16)}`;
const R1 = [...Array.from({ length: 40 }, (_, i) => `R1-${i + 1}`), LONG, 'R1-END'];
const R2 = [...Array.from({ length: 30 }, (_, i) => `R2-${i + 1}`), 'R2-END'];

writeFileSync(
  join(userDataDir, 'agents.json'),
  JSON.stringify([
    {
      id: AGENT,
      label: AGENT,
      command: 'cmd.exe',
      args: ['/k'],
      icon: 'terminal',
      color: 'green',
      cwdStrategy: 'workspaceFolder',
    },
  ]),
);

const setContentSize = (app, w, h) =>
  app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h);
    },
    { w, h },
  );

const dump = (label, lines) => log(`${label}:\n${lines.map((l) => `  | ${l}`).join('\n')}`);

/** A run's lines that didn't come back, and lines holding its text that aren't one of its lines. */
function damaged(lines, expected, tag) {
  const missing = expected.filter((l) => !lines.includes(l));
  // The typed commands (`for /L … @echo R1-%i`, `echo R1-END`) hold the tag legitimately.
  const merged = lines.filter(
    (l) => l.includes(tag) && !expected.includes(l) && !l.includes('echo'),
  );
  return { missing, merged };
}

/** Every size the xterm has had this run; a recorded segment at any other size is a transient. */
const seenSizes = new Set();
const noteSize = async (page, id) => {
  const size = await page.evaluate((s) => {
    const t = window.__terms?.[s];
    return t ? `${t.cols}x${t.rows}` : null;
  }, id);
  if (size) seenSizes.add(size);
  return size;
};
const persistedGeometries = (id) => {
  const file = join(userDataDir, `scrollback-${id.replace(/[^\w.-]/g, '_')}.json`);
  const segments = JSON.parse(readFileSync(file, 'utf8')).segments ?? [];
  return segments.filter((g) => g.cols && g.rows).map((g) => `${g.cols}x${g.rows}`);
};
// Trailing blanks are not content: a repaint omits the ones the shell's own echo wrote.
const nonEmpty = (lines) => (lines ?? []).map((l) => l.trimEnd()).filter((l) => l !== '');

let app;
let page;
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
try {
  app = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  // Survives the reload below, so the remounted pane registers its xterm too.
  await page.addInitScript(() => {
    window.__terms = {};
  });
  await page.evaluate(() => {
    window.__terms = {};
  });
  await tapBridge(page);
  await setContentSize(app, 1400, 900);

  const sid = await openSession(page, { path: REPO, agentId: AGENT });
  assert(sid, 'No session after openRepo');
  await typeLine(page, sid, 'for /L %i in (1,1,40) do @echo R1-%i');
  await typeLine(page, sid, `echo ${LONG}`);
  await typeLine(page, sid, 'echo R1-END');
  await waitForOutput(page, sid, 'R1-END');
  await noteSize(page, sid);
  await page.waitForTimeout(500);

  // ── 1. Exit, narrow the window, Restart in the same app run ────────────────
  await typeLine(page, sid, 'exit 3');
  await page.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.status === 'exited',
    sid,
    { timeout: 20000 },
  );
  await setContentSize(app, 900, 650);
  await page.evaluate(
    (id) => window.agentDeck.post({ type: 'session:restart', requestId: 9101, sessionId: id }),
    sid,
  );
  await page.waitForFunction(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.status === 'running',
    sid,
    { timeout: 20000 },
  );
  // cmd /k prints no banner, so prove the new child is up by talking to it.
  await page.waitForTimeout(1500);
  await typeLine(page, sid, 'echo AFTER-RESTART');
  await waitForOutput(page, sid, 'AFTER-RESTART');
  await page.waitForTimeout(500);
  await noteSize(page, sid);
  const restarted = (await logicalLines(page, sid)) ?? [];
  dump('after Restart (last 50)', restarted.slice(-50));
  const r1Shown = R1.filter((l) => !restarted.includes(l));
  check(r1Shown.length === 0, `Restart did not show run 1: missing ${r1Shown.join(', ')}`);
  check(
    restarted.includes(MARKER) && restarted.indexOf('R1-END') < restarted.indexOf(MARKER),
    'Restart wrote no relaunch marker below run 1',
  );

  // ── 2. A second run at the narrower size, then reload the renderer ─────────
  await typeLine(page, sid, 'for /L %i in (1,1,30) do @echo R2-%i');
  await typeLine(page, sid, 'echo R2-END');
  await waitForOutput(page, sid, 'R2-END');
  await page.waitForTimeout(1000);
  const cols = await page.evaluate((id) => window.__terms?.[id]?.cols, sid);
  log(`pane before reload: ${cols} cols`);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 20000,
  });
  await page.click(`[data-sessionid="${sid}"]`);
  await waitForOutput(page, sid, 'R2-END', 1);
  await page.waitForTimeout(2000);
  const reloaded = (await logicalLines(page, sid)) ?? [];
  dump('after reload (last 90)', reloaded.slice(-90));
  const r1 = damaged(reloaded, R1, 'R1-');
  const r2 = damaged(reloaded, R2, 'R2-');
  check(
    r1.missing.length === 0 && r2.missing.length === 0,
    `Reload lost lines: ${[...r1.missing, ...r2.missing].join(', ')}`,
  );
  check(
    r1.merged.length === 0 && r2.merged.length === 0,
    `Reload merged lines: ${JSON.stringify([...new Set([...r1.merged, ...r2.merged])])}`,
  );
  check(
    reloaded.indexOf('R1-END') < reloaded.indexOf(MARKER) &&
      reloaded.indexOf(MARKER) < reloaded.indexOf('R2-1'),
    'Reload replayed the runs out of order',
  );

  // ── 3. After every reload the PTY is exactly as big as the xterm ───────────
  // Asked of the shell itself: a PTY taller than the xterm parks the cursor below the prompt,
  // so typed text isn't where the user looks. It was intermittent, so reload several times.
  // A live resize first, so the reloads below land on a window that has changed size this run.
  await setContentSize(app, 1000, 700);
  await page.waitForTimeout(1500);
  // Late web fonts make the reloaded pane's first measurement taller than where the layout
  // settles — the timing that left the PTY taller than the xterm. Hold the font files back so
  // every reload hits it instead of some.
  log(`live before the reloads: ${await noteSize(page, sid)}`);
  const hold = await holdBackWebFonts(page, 2500);
  for (let round = 1; round <= RELOADS; round++) {
    // The window doesn't change across these reloads, so neither may the live screen.
    const before = nonEmpty(await logicalLines(page, sid));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
    await tapBridge(page);
    await assertFontsPending(page, `reload ${round}`);
    await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
      timeout: 20000,
    });
    await page.click(`[data-sessionid="${sid}"]`);
    await waitForOutput(page, sid, 'R2-END', 1);
    await page.waitForTimeout(3000);
    const after = nonEmpty(await logicalLines(page, sid)).filter((l) => l !== '— attached —');
    const lost = before.filter((l) => !after.includes(l));
    const added = after.filter((l) => !before.includes(l));
    if (after.length !== before.length) {
      dump(`reload ${round}: live screen before (last 12 of ${before.length})`, before.slice(-12));
      dump(`reload ${round}: live screen after (last 12 of ${after.length})`, after.slice(-12));
    }
    check(
      lost.length === 0 && added.length === 0,
      `Reload ${round} changed the live screen with no resize: lost ${JSON.stringify(lost.slice(0, 8))}, gained ${JSON.stringify(added.slice(0, 8))}`,
    );
    const probe = `SIZE-PROBE-${round}`;
    const sizes = await probeTerminalSize(page, sid, probe);
    log(
      `reload ${round}: xterm ${sizes.xterm} (screen ${sizes.screenH}px in a ${sizes.paneH}px pane), PTY ${sizes.pty}`,
    );
    check(
      sizes.screenH > 0 && sizes.screenH <= sizes.paneH,
      `Reload ${round}: screen ${sizes.screenH}px overflows a ${sizes.paneH}px pane`,
    );
    check(sizes.xterm === sizes.pty, `Reload ${round}: xterm ${sizes.xterm} but PTY ${sizes.pty}`);
    seenSizes.add(sizes.xterm);
    await page.waitForTimeout(600);
    const transient = persistedGeometries(sid).filter((g) => !seenSizes.has(g));
    check(
      transient.length === 0,
      `Reload ${round}: history recorded at ${[...new Set(transient)].join(', ')}, a size the xterm never had (it had ${[...seenSizes].join(', ')})`,
    );
  }

  assertFontsHeldBack(hold, 'scrollback-inrun');
  assert(failures.length === 0, failures.join('\n  '));
  log('PASS ✓ Restart in one app run shows history; a reload over mixed sizes keeps every line');
  await shutdownApp(app, page);
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[scrollback-inrun] FAIL ✗', e.message);
  else {
    console.error('[scrollback-inrun] ERROR:', e?.message || e, e?.stack ?? '');
    if (failures.length)
      console.log('[scrollback-inrun] failed checks so far:\n ', failures.join('\n  '));
  }
  await shutdownApp(app, page).catch(() => {});
  await finishScenario(isAssertion ? 1 : 2);
}
