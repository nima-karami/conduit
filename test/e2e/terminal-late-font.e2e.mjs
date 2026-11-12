/**
 * A terminal still fits its pane, and the PTY its terminal, while the page's web fonts are late.
 *
 * Holding the bundled terminal faces back past the boot font wait makes a reloaded page's layout
 * settle late: the pane's first measurement is taller than where it ends up. On main that left the grid taller than the pane —
 * its bottom rows, the cursor and what the user types below the visible area until `clear` — and
 * the PTY a different height again. The fonts are held back so that timing is certain, not a race.
 * (The late font itself doesn't change the cell size here; the control terminal pins that.)
 *
 * Checked twice, each time after the font has arrived: a fresh session on a fresh document, and
 * the same session after a renderer reload (the attach path). Both times the xterm's screen must
 * fit inside its pane, the PTY (asked of the shell, `mode con`) must be the xterm's size, and the
 * cell must be as wide as the real face's advance: a terminal still measured in its fallback face
 * after the late face arrived would not be.
 */
import { createRequire } from 'node:module';
import {
  assert,
  assertFontsHeldBack,
  assertFontsPending,
  finishScenario,
  fontHoldDiagnostics,
  holdBackLocalFonts,
  launchElectron,
  makeLog,
  measureCellWidth,
  openSession,
  probeTerminalSize,
  profileDir,
  REPO,
  shutdownApp,
  tapBridge,
  terminalFace,
  windowsOnlyScenario,
} from './harness.mjs';

await windowsOnlyScenario('terminal-late-font', 'cmd.exe shell sessions');

const log = makeLog('terminal-late-font');
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const userDataDir = profileDir('tlf');
// Past the boot font wait (BOOT_FONT_TIMEOUT_MS, 3 s), so the first terminal mounts in a fallback.
const FONT_DELAY_MS = 6000;

/**
 * Waits for the session's terminal to have refit after the late face arrived: cells as wide as
 * the real face's advance and the screen inside its pane. These are the facts judged next, so a
 * terminal that never gets there times out here and is then reported by the judges, not hidden.
 */
async function waitTerminalSettled(page, id) {
  await page
    .waitForFunction(
      (sid) => {
        const t = window.__terms?.[sid];
        const screen = t?.element?.querySelector('.xterm-screen');
        const pane = t?.element?.closest('.termpane');
        if (!t || !screen || !pane) return false;
        const px = Number(t.options.fontSize);
        const ctx = document.createElement('canvas').getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        ctx.font = `${px}px ${String(t.options.fontFamily)}`;
        const expected = Math.floor(ctx.measureText('W').width * dpr) / dpr;
        const box = screen.getBoundingClientRect();
        return (
          Math.abs(box.width / t.cols - expected) < 0.05 &&
          box.height > 0 &&
          box.height <= pane.clientHeight
        );
      },
      id,
      { timeout: 15000 },
    )
    .catch((error) => {
      if (error.name !== 'TimeoutError') throw error;
      log(`terminal ${id} had not settled after 15 s; the judges report what is wrong`);
    });
}

async function waitForFont(page, id) {
  const { family, px } = await terminalFace(page);
  const font = `${px}px "${family}"`;
  log(
    `${family} faces before: ${await page.evaluate(
      (fam) =>
        [...document.fonts]
          .filter((f) => f.family.includes(fam))
          .map((f) => `${f.weight}:${f.status}`)
          .join(','),
      family,
    )}`,
  );
  // Under WebGL nothing in the page requests the face; the editor or a code block would.
  await page.evaluate((f) => document.fonts.load(f), font);
  await page.waitForFunction((f) => document.fonts.check(f), font, { timeout: 30000 });
  await waitTerminalSettled(page, id);
}

const measure = (page, id, label) => probeTerminalSize(page, id, `FONT-PROBE-${label}`);

let app;
let page;
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
function judgeWidth(label, w) {
  if (!w) return check(false, `${label}: no terminal to measure`);
  log(
    `${label}: cell ${w.cell}px wide, ${w.face} advance ${w.expected}px, fallback advance ${w.fallback}px${
      w.expected === w.fallback ? ' (same width: this size cannot tell the faces apart)' : ''
    }`,
  );
  check(w.loaded, `${label}: ${w.face} is still not loaded`);
  check(
    Math.abs(w.cell - w.expected) < 0.05,
    `${label}: cells are ${w.cell}px wide, but ${w.face} makes them ${w.expected}px`,
  );
}
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
  const hold = await holdBackLocalFonts(app, page, FONT_DELAY_MS);
  // A fresh document under the hook: the font the window already had is gone.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  log(
    `font hold after fresh-document reload: ${JSON.stringify(await fontHoldDiagnostics(hold, page))}`,
  );
  await assertFontsPending(page, 'fresh document');

  // ── 1. A fresh session, its font arriving after its first fit ─────────────
  const sid = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
  assert(sid, 'No session after openRepo');
  await waitForFont(page, sid);
  // A terminal opened once the font is in: the cell size every terminal should have.
  const control = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
  const truth = await measure(page, control, 'control');
  log(`control (opened after the font): xterm ${truth.xterm}, cell ${truth.cellH}px`);
  await page.click(`[data-sessionid="${sid}"]`);
  await waitTerminalSettled(page, sid);
  judge('fresh session', await measure(page, sid, 'fresh'), truth.cellH);
  judgeWidth('fresh session', await measureCellWidth(page, sid));

  // ── 2. The same session after a reload (attach path), fonts late again ────
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  log(`font hold after attach reload: ${JSON.stringify(await fontHoldDiagnostics(hold, page))}`);
  await assertFontsPending(page, 'reload');
  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 20000,
  });
  await page.click(`[data-sessionid="${sid}"]`);
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 20000 });
  await waitForFont(page, sid);
  judge('after reload', await measure(page, sid, 'reload'), truth.cellH);
  judgeWidth('after reload', await measureCellWidth(page, sid));

  await assertFontsHeldBack(hold, 'terminal-late-font');
  assert(failures.length === 0, failures.join('\n  '));
  log('PASS ✓ with late terminal fonts the grid stays inside its pane and the PTY at its size');
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
