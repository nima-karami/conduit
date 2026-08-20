/**
 * A relaunched session must not inherit mouse tracking from its replayed scrollback.
 *
 * Persisted scrollback is raw ANSI replayed with `term.write()`, which cannot tell history
 * from a live command. A TUI killed by `pty.dispose()` never emits its `ESC[?1003l`, so the
 * history's last word on mouse mode is "on" — and the replay re-armed it against the FRESH
 * shell spawned underneath. Every pointer move then typed a mouse report at the prompt
 * (`35;57;21M35;59;21M…`, a real user report). See
 * docs/specs/2026-08-20-scrollback-replay-neutralizer.md.
 *
 * Seeds sessions.json + scrollback-<id>.json directly (deterministic — no live TUI to race),
 * relaunches the way the UI does, then asserts on the REAL xterm instance: mouse tracking is
 * off, and actual pointer movement over the viewport produces no report on `onData`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, loadPlaywright, makeLog, REPO, shutdownApp, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[scrollback-mode-neutralize] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('scrollback-mode-neutralize');
const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-sbmn-'));
const SID = 'mouseseed1';
const SENTINEL = `SBMN-${Date.now()}`;

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
// What a killed TUI leaves behind: any-event tracking + SGR encoding, no matching reset.
writeFileSync(
  join(userDataDir, `scrollback-${SID}.json`),
  JSON.stringify({
    version: 1,
    sessionId: SID,
    data: `${SENTINEL}\r\n\x1b[?1003h\x1b[?1006h\x1b[?1049h\x1b[?2004hfake-tui-was-here\r\n`,
  }),
);

let app;
let page;
try {
  app = await _electron.launch({
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
  // Let the restored session register before relaunch (the kill-race guard drops a term:start
  // that races restore).
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    window.__terms = {};
  });
  await page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), SID);

  await page.waitForFunction((s) => (window.__cap || '').includes(s), SENTINEL, { timeout: 20000 });
  await page.waitForFunction(() => /Microsoft Windows|>/.test(window.__cap || ''), null, {
    timeout: 20000,
  });
  await page.waitForTimeout(1500);

  // Tap what the terminal would SEND. A mouse report goes out through onData whatever the
  // shell then does with it, so this doesn't depend on shell echo.
  const tapped = await page.evaluate((id) => {
    const t = window.__terms?.[id];
    if (!t) return false;
    window.__typed = '';
    t.onData((d) => {
      window.__typed += d;
    });
    return true;
  }, SID);
  assert(tapped, 'Terminal was not exposed on window.__terms — cannot observe outbound data');

  const box = await page.locator('.xterm-screen').first().boundingBox();
  assert(box, '.xterm-screen has no bounding box');
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width * (i / 10), box.y + box.height * (i / 10));
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);

  const typed = await page.evaluate(() => window.__typed || '');
  assert(
    !typed.includes('\x1b[<') && !/\d+;\d+;\d+[Mm]/.test(typed),
    `Mouse movement over the terminal sent a mouse report to the shell: ${JSON.stringify(typed)}`,
  );

  const modes = await page.evaluate((id) => ({ ...window.__terms[id].modes }), SID);
  assert(
    modes.mouseTrackingMode === 'none',
    `Replayed history left mouse tracking armed against the fresh shell (mouseTrackingMode=${modes.mouseTrackingMode})`,
  );
  // Only mouse tracking is asserted: the other neutralized modes can legitimately be re-set
  // by the fresh shell itself (PSReadLine turns bracketed paste on), so they aren't stable.
  assert(!modes.sendFocusMode, `Replayed focus reporting leaked onto the fresh shell`);

  const buf = await page.evaluate((id) => {
    const b = window.__terms[id].buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }, SID);
  assert(
    buf.includes(SENTINEL),
    `Restored history is missing — the neutralizer must not cost the replay. Buffer:\n${buf}`,
  );

  log('PASS ✓ relaunched session ignores the replayed mouse-tracking mode');
  await shutdownApp(app, page);
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) console.log('[scrollback-mode-neutralize] FAIL ✗', e.message);
  else console.error('[scrollback-mode-neutralize] ERROR:', e?.message || e, e?.stack ?? '');
  await shutdownApp(app, page).catch(() => {});
  process.exit(isAssertion ? 1 : 2);
}
