/**
 * A terminal still fits its pane, and the PTY its terminal, while the page's web fonts are late.
 *
 * Holding the Google Fonts files back makes a reloaded page's layout settle late: the pane's first
 * measurement is taller than where it ends up. On main that left the grid taller than the pane —
 * its bottom rows, the cursor and what the user types below the visible area until `clear` — and
 * the PTY a different height again. The fonts are held back so that timing is certain, not a race.
 * (The late font itself doesn't change the cell size here; the control terminal pins that.)
 *
 * Checked twice, each time after the font has arrived: a fresh session on a fresh document, and
 * the same session after a renderer reload (the attach path). Both times the xterm's screen must
 * fit inside its pane, and the PTY (asked of the shell, `mode con`) must be the xterm's size.
 */
import { createRequire } from 'node:module';
import {
  assert,
  assertFontsHeldBack,
  assertFontsPending,
  finishScenario,
  holdBackWebFonts,
  launchElectron,
  makeLog,
  openSession,
  profileDir,
  REPO,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[terminal-late-font] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('terminal-late-font');
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const userDataDir = profileDir('tlf');
const FONT_DELAY_MS = 3000;

const typeLine = (page, id, data) =>
  page.evaluate(
    ({ s, d }) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: `${d}\r` }),
    { s: id, d: data },
  );

async function waitForFont(page) {
  await page.waitForTimeout(1000);
  log(
    `faces before: ${await page.evaluate(() =>
      [...document.fonts]
        .filter((f) => /JetBrains/.test(f.family) && f.weight === '400')
        .map((f) => f.status)
        .join(','),
    )}`,
  );
  // Under WebGL nothing in the page requests the face; the editor or a code block would.
  await page.evaluate(() => document.fonts.load('14px "JetBrains Mono"'));
  await page.waitForFunction(() => document.fonts.check('14px "JetBrains Mono"'), null, {
    timeout: 30000,
  });
  await page.waitForTimeout(1500);
}

/** The xterm's grid and screen against its pane, and the PTY's size as the shell reports it. */
async function measure(page, id, label) {
  const probe = `FONT-PROBE-${label}`;
  await typeLine(page, id, `echo ${probe} & mode con | findstr "Lines Columns"`);
  await page.waitForFunction(
    ({ s, p }) => /Columns:\s*\d+/.test((window.__capBy?.[s] ?? '').split(p).at(-1) ?? ''),
    { s: id, p: probe },
    { timeout: 20000 },
  );
  return page.evaluate(
    ({ s, p }) => {
      const t = window.__terms?.[s];
      const after = (window.__capBy?.[s] ?? '').split(p).at(-1) ?? '';
      const screen = t?.element?.querySelector('.xterm-screen');
      const pane = t?.element?.closest('.termpane');
      return {
        xterm: t ? `${t.cols}x${t.rows}` : 'none',
        pty: `${/Columns:\s*(\d+)/.exec(after)?.[1]}x${/Lines:\s*(\d+)/.exec(after)?.[1]}`,
        screenH: Math.round(screen?.getBoundingClientRect().height ?? -1),
        paneH: Math.round(pane?.clientHeight ?? -1),
        cellH:
          Math.round(((screen?.getBoundingClientRect().height ?? 0) / (t?.rows || 1)) * 100) / 100,
      };
    },
    { s: id, p: probe },
  );
}

let app;
let page;
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
function judge(label, m, truthCell) {
  log(
    `${label}: xterm ${m.xterm} (screen ${m.screenH}px, cell ${m.cellH}px, in a ${m.paneH}px pane), PTY ${m.pty}`,
  );
  check(
    m.screenH > 0 && m.screenH <= m.paneH,
    `${label}: screen ${m.screenH}px overflows a ${m.paneH}px pane`,
  );
  check(m.xterm === m.pty, `${label}: xterm ${m.xterm} but PTY ${m.pty}`);
  check(
    Math.abs(m.cellH - truthCell) < 0.5,
    `${label}: cells are ${m.cellH}px, but the loaded font makes them ${truthCell}px`,
  );
}

try {
  app = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await page.addInitScript(() => {
    window.__terms = {};
  });
  const hold = await holdBackWebFonts(page, FONT_DELAY_MS);
  // A fresh document under the hook: the font the window already had is gone.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  await assertFontsPending(page, 'fresh document');

  // ── 1. A fresh session, its font arriving after its first fit ─────────────
  const sid = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
  assert(sid, 'No session after openRepo');
  await waitForFont(page);
  // A terminal opened once the font is in: the cell size every terminal should have.
  const control = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
  const truth = await measure(page, control, 'control');
  log(`control (opened after the font): xterm ${truth.xterm}, cell ${truth.cellH}px`);
  await page.click(`[data-sessionid="${sid}"]`);
  await page.waitForTimeout(1000);
  judge('fresh session', await measure(page, sid, 'fresh'), truth.cellH);

  // ── 2. The same session after a reload (attach path), fonts late again ────
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  await assertFontsPending(page, 'reload');
  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 20000,
  });
  await page.click(`[data-sessionid="${sid}"]`);
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 20000 });
  await waitForFont(page);
  judge('after reload', await measure(page, sid, 'reload'), truth.cellH);

  assertFontsHeldBack(hold, 'terminal-late-font');
  assert(failures.length === 0, failures.join('\n  '));
  log('PASS ✓ with late web fonts the grid stays inside its pane and the PTY at its size');
  await shutdownApp(app, page);
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[terminal-late-font] FAIL ✗', e.message);
  else {
    console.error('[terminal-late-font] ERROR:', e?.message || e, e?.stack ?? '');
    if (failures.length)
      console.log('[terminal-late-font] failed checks so far:\n ', failures.join('\n  '));
  }
  await shutdownApp(app, page).catch(() => {});
  await finishScenario(isAssertion ? 1 : 2);
}
