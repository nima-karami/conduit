/**
 * Restored history replays at the size it was recorded at.
 *
 * ConPTY paints absolutely — every row placed by cursor position at the PTY's width — so bytes
 * replayed at any other width re-wrap and land on each other. A v2 scrollback file records each
 * segment's {cols, rows}; the host passes them with the cold replay and the renderer writes each
 * segment at its own size before fitting back to the pane (xterm then reflows it).
 *
 * Pre-seeds a v2 file whose two segments are WIDER than the pane, the later one wider still (so
 * writing both at the first one's size fails too), then relaunches and reads the rendered xterm
 * buffer: every recorded row must come back as one
 * logical line (soft-wrapped rows rejoined), intact.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  assert,
  finishScenario,
  launchElectron,
  logicalLines,
  makeLog,
  profileDir,
  REPO,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[scrollback-geometry] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('scrollback-geometry');
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const userDataDir = profileDir('sbg');
const SID = 'geometryseed1';
const A = { cols: 300, rows: 12 };
const B = { cols: 400, rows: 12 };

// Five full-width rows by absolute position, the cursor parked below them (xterm never reflows
// the cursor's own row), then newlines that scroll the frame into history as later output would.
function conptyFrame(tag, g) {
  const rows = Array.from({ length: 5 }, (_, i) => `${tag}${i}:`.padEnd(g.cols, `${i}`));
  const data = `${rows.map((t, i) => `\x1b[${i + 1};1H${t}`).join('')}\x1b[6;1H${'\r\n'.repeat(g.rows)}`;
  return { rows, data };
}
const frameA = conptyFrame('geoA', A);
const frameB = conptyFrame('geoB', B);

writeFileSync(
  join(userDataDir, 'sessions.json'),
  JSON.stringify({
    version: 1,
    sessions: [
      {
        id: SID,
        name: 'seed',
        agentId: 'shell:cmd',
        projectPath: REPO,
        status: 'running',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
    ],
  }),
);
writeFileSync(
  join(userDataDir, `scrollback-${SID}.json`),
  JSON.stringify({
    version: 2,
    sessionId: SID,
    segments: [
      { ...A, data: frameA.data },
      { ...B, data: frameB.data },
    ],
  }),
);

let app;
let page;
try {
  app = await launchElectron({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);

  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), SID, {
    timeout: 20000,
  });
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    window.__terms = {};
  });
  await page.click(`[data-sessionid="${SID}"]`);
  await page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), SID);

  await page.waitForFunction((s) => (window.__cap || '').includes(s), frameB.rows[4], {
    timeout: 20000,
  });
  await page.waitForFunction(() => /Microsoft Windows/.test(window.__cap || ''), null, {
    timeout: 20000,
  });
  await page.waitForTimeout(1500);

  const lines = await logicalLines(page, SID);
  const cols = await page.evaluate((id) => window.__terms?.[id]?.cols, SID);
  const buf = lines && { cols, lines };

  assert(buf, 'Relaunched terminal was not exposed on window.__terms');
  log(`pane is ${buf.cols} cols; recorded segments ${A.cols} and ${B.cols} cols`);
  assert(
    buf.cols < Math.min(A.cols, B.cols),
    `Pane (${buf.cols} cols) is not narrower than the recorded segments — nothing to prove`,
  );
  const missing = [...frameA.rows, ...frameB.rows].filter((row) => !buf.lines.includes(row));
  log(
    `logical lines holding a recorded row tag:\n${buf.lines
      .filter((l) => l.startsWith('geo'))
      .map((l) => `  | ${l.slice(0, 24)}… (${l.length} chars)`)
      .join('\n')}`,
  );
  assert(
    missing.length === 0,
    `Recorded rows not restored intact (replayed at the wrong size?): ${missing
      .map((r) => r.slice(0, 6))
      .join(', ')}`,
  );
  log('PASS ✓ each segment replays at its recorded size and reflows to the pane');

  await shutdownApp(app, page);
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[scrollback-geometry] FAIL ✗', e.message);
  else console.error('[scrollback-geometry] ERROR:', e?.message || e, e?.stack ?? '');
  await shutdownApp(app, page).catch(() => {});
  await finishScenario(isAssertion ? 1 : 2);
}
