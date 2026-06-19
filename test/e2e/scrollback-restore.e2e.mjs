/**
 * Scrollback restore survives the PTY spawn (regression).
 *
 * The sibling `scrollback.e2e.mjs` only asserts the restored bytes are re-sent over
 * IPC (`__cap`). That blind spot let a real bug ship: on Windows, ConPTY's spawn emits
 * `ESC[2J ESC[H` and repaints the viewport absolutely, erasing the just-replayed history
 * — the user saw it flash, then a fresh shell. This scenario asserts on the RENDERED
 * xterm buffer (via the opt-in `window.__terms` hook), which is what the user actually
 * sees: after relaunch the restored sentinel must be present AND in scrollback (baseY>0),
 * not wiped by the ConPTY clear.
 *
 * Pre-seeds sessions.json + scrollback-<id>.json directly (deterministic — no live shell
 * echo to race), then relaunches the restored session the way the UI does.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, loadPlaywright, makeLog, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[scrollback-restore] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('scrollback-restore');
const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-sbr-'));
const SID = 'restoreseed1';
const SENTINEL = `SBR-${Date.now()}`;

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
    version: 1,
    sessionId: SID,
    data: `${SENTINEL}\r\nhistory-line-a\r\nhistory-line-b\r\n`,
  }),
);

let app;
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);

  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), SID, {
    timeout: 20000,
  });
  // Let the restored session register before relaunch (kill-race guard drops a term:start
  // that races restore).
  await page.waitForTimeout(1000);

  // Opt in to the terminal-exposure hook, then relaunch (mounts a real pane → term:start).
  await page.evaluate(() => {
    window.__terms = {};
  });
  await page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), SID);

  // Wait until the live shell has spawned and painted (its prompt arrives AFTER the
  // ConPTY clear that used to wipe the replay) — then inspect the buffer.
  await page.waitForFunction((s) => (window.__cap || '').includes(s), SENTINEL, { timeout: 20000 });
  await page.waitForFunction(() => /Microsoft Windows|>/.test(window.__cap || ''), null, {
    timeout: 20000,
  });
  await page.waitForTimeout(1500);

  const buf = await page.evaluate((id) => {
    const t = window.__terms?.[id];
    if (!t) return { error: 'terminal not exposed' };
    const b = t.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
    return { baseY: b.baseY, text: lines.join('\n') };
  }, SID);

  assert(!buf.error, `Could not read terminal buffer: ${buf.error}`);
  assert(
    buf.text.includes(SENTINEL),
    `Restored sentinel "${SENTINEL}" missing from rendered buffer after PTY spawn (ConPTY clear wiped it). Buffer:\n${buf.text}`,
  );
  assert(buf.baseY > 0, `Restored history was not pushed into scrollback (baseY=${buf.baseY})`);
  log(`PASS ✓ restored history survives the PTY spawn (in scrollback, baseY=${buf.baseY})`);

  await app.close();
  app = null;
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[scrollback-restore] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[scrollback-restore] ERROR:', e?.message || e);
  try {
    if (app) await app.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
}
