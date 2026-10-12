/**
 * A live shrink-then-grow of a terminal keeps every line of its history, once — and so does the
 * cold replay of that history after a quit.
 *
 * ConPTY keeps its viewport anchored at the top when the console grows and repaints it from the
 * home position. An xterm not told it runs on ConPTY (`windowsPty`) pulls scrollback down into
 * the viewport on a grow instead, so the repaint lands on those rows: shrinking to 12 rows and
 * back lost ~34 lines of a 40-line run on cmd.exe. Every check is collected and reported together.
 */
import { createRequire } from 'node:module';
import {
  assert,
  finishScenario,
  launchElectron,
  makeLog,
  openSession,
  profileDir,
  REPO,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[resize-history] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('resize-history');
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const userDataDir = profileDir('rsh');
const WIDTH = 1400;
const TALL = 900;
const SHORT_ROWS = 12;
const RUN1 = Array.from({ length: 40 }, (_, i) => `RUN1-${i + 1}`);
const RUN2 = Array.from({ length: 16 }, (_, i) => `RUN2-${i + 1}`);
const EXPECTED = [...RUN1, ...RUN2];

const logicalLines = (page, id) =>
  page.evaluate((sessionId) => {
    const t = window.__terms?.[sessionId];
    if (!t) return null;
    const b = t.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    return out;
  }, id);

const rowsOf = (page, id) => page.evaluate((s) => window.__terms?.[s]?.rows ?? 0, id);

const typeLine = (page, id, data) =>
  page.evaluate(
    ({ s, d }) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: `${d}\r` }),
    { s: id, d: data },
  );

// Twice: the typed command echoes the marker, then cmd prints it.
const waitForOutput = (page, id, text, occurrences = 2) =>
  page.waitForFunction(
    ({ s, t, n }) => (window.__capBy?.[s] ?? '').split(t).length > n,
    { s: id, t: text, n: occurrences },
    { timeout: 30000 },
  );

const setContentHeight = (app, h) =>
  app.evaluate(
    ({ BrowserWindow }, size) => {
      const w = BrowserWindow.getAllWindows()[0];
      // The window's own minimum keeps the pane well above 12 rows.
      w?.setMinimumSize(400, 200);
      w?.setContentSize(size.w, size.h);
    },
    { w: WIDTH, h },
  );

/** Resize until the pane holds `rows`, then let ConPTY's repaint for it land. */
async function resizeToRows(app, page, id, rows, pxPerRow) {
  const current = await rowsOf(page, id);
  const [, h] = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentSize(),
  );
  await setContentHeight(app, Math.round(h - (current - rows) * pxPerRow));
  await page.waitForFunction(
    ({ s, r }) => Math.abs((window.__terms?.[s]?.rows ?? 0) - r) <= 1,
    { s: id, r: rows },
    { timeout: 10000 },
  );
  await page.waitForTimeout(1500);
  return rowsOf(page, id);
}

const notOnce = (lines) =>
  EXPECTED.map((l) => [l, (lines ?? []).filter((x) => x.trimEnd() === l).length]).filter(
    ([, n]) => n !== 1,
  );

const dump = (label, lines) => log(`${label}:\n${lines.map((l) => `  | ${l}`).join('\n')}`);

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
  await page.evaluate(() => {
    window.__terms = {};
  });
  await tapBridge(page);
  await setContentHeight(app, TALL);
  await page.waitForTimeout(500);

  const sid = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
  assert(sid, 'No session after openRepo');
  await page.waitForFunction((s) => !!window.__terms?.[s], sid, { timeout: 10000 });
  await page.waitForFunction(
    (s) => (window.__capBy?.[s] ?? '').includes('Microsoft Windows'),
    sid,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1000);
  const tallRows = await rowsOf(page, sid);
  const pxPerRow = await page.evaluate((s) => {
    const t = window.__terms[s];
    return t.element.querySelector('.xterm-screen').clientHeight / t.rows;
  }, sid);
  log(`tall pane: ${tallRows} rows, ${pxPerRow.toFixed(1)}px a row`);
  assert(tallRows > SHORT_ROWS + 10, `Tall pane has only ${tallRows} rows — nothing to grow into`);

  await typeLine(page, sid, 'for /L %i in (1,1,40) do @echo RUN1-%i');
  await typeLine(page, sid, 'echo RUN1-END');
  await waitForOutput(page, sid, 'RUN1-END');
  await page.waitForTimeout(800);

  for (const [round, run] of [
    [1, null],
    [2, 'RUN2'],
  ]) {
    if (run) {
      await typeLine(page, sid, `for /L %i in (1,1,${RUN2.length}) do @echo ${run}-%i`);
      await typeLine(page, sid, `echo ${run}-END`);
      await waitForOutput(page, sid, `${run}-END`);
      await page.waitForTimeout(800);
    }
    const short = await resizeToRows(app, page, sid, SHORT_ROWS, pxPerRow);
    const tall = await resizeToRows(app, page, sid, tallRows, pxPerRow);
    log(`round ${round}: shrank to ${short} rows, grew back to ${tall}`);
  }

  const live = (await logicalLines(page, sid)) ?? [];
  const liveBad = notOnce(live);
  if (liveBad.length)
    dump(
      'live buffer after the resizes',
      live.filter((l) => l.trim()),
    );
  check(
    liveBad.length === 0,
    `Live resize: lines not present exactly once: ${JSON.stringify(liveBad)}`,
  );

  // ── Cold relaunch: the persisted history replays run by run at its recorded sizes ──
  await page.waitForTimeout(1000);
  await shutdownApp(app, page);
  app = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 20000,
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.__terms = {};
  });
  await page.click(`[data-sessionid="${sid}"]`);
  await page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), sid);
  await page.waitForFunction((s) => (window.__capBy?.[s] ?? '').includes('RUN2-END'), sid, {
    timeout: 20000,
  });
  await page.waitForFunction((s) => /Microsoft Windows/.test(window.__capBy?.[s] ?? ''), sid, {
    timeout: 30000,
  });
  await page.waitForTimeout(1500);
  const replayed = (await logicalLines(page, sid)) ?? [];
  const replayBad = notOnce(replayed);
  if (replayBad.length)
    dump(
      'replayed buffer',
      replayed.filter((l) => l.trim()),
    );
  check(
    replayBad.length === 0,
    `Cold replay: lines not present exactly once: ${JSON.stringify(replayBad)}`,
  );

  assert(failures.length === 0, failures.join('\n  '));
  log('PASS ✓ shrink/grow keeps every line once, live and after a cold replay');
  await shutdownApp(app, page);
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[resize-history] FAIL ✗', e.message);
  else {
    console.error('[resize-history] ERROR:', e?.message || e, e?.stack ?? '');
    if (failures.length)
      console.log('[resize-history] failed checks so far:\n ', failures.join('\n  '));
  }
  await shutdownApp(app, page).catch(() => {});
  await finishScenario(isAssertion ? 1 : 2);
}
