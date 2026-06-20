/**
 * Multi-window — Slice A (foundation) real-runtime acceptance.
 *
 * Drives the REAL app (CONDUIT_E2E=1 → windows hidden). Proves the locked Slice A
 * invariants:
 *   - New Window (win:new) opens a 2nd independent window.
 *   - Session ownership is isolated: window 1 sees only its sessions, window 2 only its.
 *   - term:data routing is per-owner: output for a window-2 session never reaches window 1.
 *   - Closing window 2 leaves window 1 alive (windows are independent).
 *
 * Evidence: screenshots of both windows + this log under .autoloop/evidence/.
 *
 * Windows only. KNOWN flake: Playwright app.close() teardown may time out — that is
 * fine IF the assertions printed PASS first.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, launchApp, makeLog, REPO } from './harness.mjs';

const log = makeLog('multi-window');

if (process.platform !== 'win32') {
  console.log('[multi-window] SKIP — suite is Windows-only');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(here, '..', '..', '.autoloop', 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: join(EVIDENCE, name) }).catch(() => {
    /* hidden window screenshot is best-effort */
  });

/** Tap a window's bridge: accumulate its term:data + latest owned-session list. Idempotent. */
async function tap(page) {
  await page.evaluate(() => {
    if (window.__mwTapped) return;
    window.__mwTapped = true;
    window.__cap = '';
    window.__sessions = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'term:data') window.__cap += m.data;
      if (m.type === 'state') window.__sessions = m.sessions || [];
    });
    window.agentDeck.post({ type: 'ready' });
  });
}

/** Open a session in THIS window (posts openRepo from its renderer → host owns it to this win). */
async function openSessionIn(page, { path, agentId = 'shell:cmd' }) {
  await tap(page);
  const before = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));
  await page.evaluate(
    ({ p, a }) => window.agentDeck.post({ type: 'openRepo', path: p, agentId: a }),
    { p: path.replace(/\\/g, '/'), a: agentId },
  );
  await page.waitForSelector('.termpane', { state: 'attached', timeout: 25000 });
  return page
    .waitForFunction(
      (ids) => {
        const cur = (window.__sessions || []).map((s) => s.id);
        return cur.find((id) => !ids.includes(id)) || null;
      },
      before,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue());
}

const ids = (page) => page.evaluate(() => (window.__sessions || []).map((s) => s.id));

let launched = null;
try {
  launched = await launchApp();
  const { app, page: page1 } = launched;
  await tap(page1);

  // A fresh launch auto-opens a session from the REPO launch arg. Kill any pre-existing
  // sessions so the isolation assertions reason over exactly the sessions we create.
  await page1.evaluate(() => {
    for (const s of window.__sessions || []) window.agentDeck.post({ type: 'kill', id: s.id });
  });
  await page1
    .waitForFunction(() => (window.__sessions || []).length === 0, null, { timeout: 10000 })
    .catch(() => {});

  // ── Window 1: start session A ───────────────────────────────────────────────
  const sidA = await openSessionIn(page1, { path: REPO });
  log('window-1 session A =', sidA);
  assert(sidA, 'Expected a session id for A in window 1');

  // ── New Window via win:new → 2nd window appears ─────────────────────────────
  const idsBefore = await app.evaluate((e) => e.BrowserWindow.getAllWindows().map((w) => w.id));
  const win2Promise = app.waitForEvent('window', { timeout: 20000 });
  await page1.evaluate(() => window.agentDeck.post({ type: 'win:new' }));
  const page2 = await win2Promise;
  await page2.waitForLoadState('domcontentloaded');
  await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tap(page2);
  log('window-2 opened');

  const winCount = await app.evaluate((e) => e.BrowserWindow.getAllWindows().length);
  assert(winCount === 2, `Expected 2 windows after win:new, got ${winCount}`);
  // Identify window 2's BrowserWindow id (the one not present before win:new).
  const win2Id = await app.evaluate(
    (e, before) =>
      e.BrowserWindow.getAllWindows()
        .map((w) => w.id)
        .find((id) => !before.includes(id)),
    idsBefore,
  );
  assert(typeof win2Id === 'number', 'Could not resolve window 2 id');
  log('window count = 2 ✓ (window-2 id =', win2Id, ')');

  // New window starts empty (no owned sessions) → empty-state.
  const w2Initial = await ids(page2);
  assert(
    w2Initial.length === 0,
    `New window should own 0 sessions, saw ${JSON.stringify(w2Initial)}`,
  );
  log('window-2 starts empty ✓');

  // ── Window 2: start session B ───────────────────────────────────────────────
  const sidB = await openSessionIn(page2, { path: REPO });
  log('window-2 session B =', sidB);
  assert(sidB && sidB !== sidA, 'Expected a distinct session id for B in window 2');

  // ── ASSERT ISOLATION: each window sees only its own sessions ─────────────────
  // Settle so both windows have received their latest filtered state.
  await page1.waitForTimeout(500);
  const w1 = await ids(page1);
  const w2 = await ids(page2);
  log('window-1 sessions =', JSON.stringify(w1));
  log('window-2 sessions =', JSON.stringify(w2));

  assert(w1.includes(sidA), 'Window 1 must contain its own session A');
  assert(!w1.includes(sidB), 'ISOLATION: Window 1 must NOT see session B (owned by window 2)');
  assert(w2.includes(sidB), 'Window 2 must contain its own session B');
  assert(!w2.includes(sidA), 'ISOLATION: Window 2 must NOT see session A (owned by window 1)');
  log('PASS isolation: window-1 has A not B; window-2 has B not A ✓');

  // ── ASSERT term ROUTING: B's output never reaches window 1 ───────────────────
  // Wait for B's shell to actually emit (the prompt) so it's ready for stdin, then send
  // the sentinel echo. Without this the input can land before ConPTY attaches.
  await page2
    .waitForFunction(() => (window.__cap || '').length > 0, null, { timeout: 15000 })
    .catch(() => {});
  await page2.waitForTimeout(800);
  const SENTINEL = `MW_SENTINEL_${Date.now()}`;
  await page1.evaluate(() => {
    window.__cap = '';
  });
  await page2.evaluate(
    ({ id, s }) => {
      window.__cap = '';
      window.agentDeck.post({ type: 'term:input', sessionId: id, data: `echo ${s}\r` });
    },
    { id: sidB, s: SENTINEL },
  );
  // Wait for B's echo to surface in window 2's buffer.
  const arrivedInW2 = await page2
    .waitForFunction((s) => (window.__cap || '').includes(s), SENTINEL, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  assert(arrivedInW2, "Window 2 should receive its own session B's output");
  // Window 1 must NOT have received B's output.
  const leakedToW1 = await page1.evaluate((s) => (window.__cap || '').includes(s), SENTINEL);
  assert(!leakedToW1, 'ISOLATION: window-1 term buffer must NOT contain window-2 session B output');
  log('PASS term routing: B output reached window-2, never window-1 ✓');

  await shot(page1, 'multi-window-w1.png');
  await shot(page2, 'multi-window-w2.png');

  // ════════════════════════════════════════════════════════════════════════════
  // Slice B — move a LIVE session between windows without restarting its PTY.
  // ════════════════════════════════════════════════════════════════════════════
  // Resolve window-1's own id from its state.windowId (added in Slice B).
  await page1.evaluate(() => {
    window.__winId = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state' && typeof m.windowId === 'number') window.__winId = m.windowId;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  await page2.evaluate(() => {
    window.__winId = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state' && typeof m.windowId === 'number') window.__winId = m.windowId;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  await page1.waitForFunction(() => window.__winId != null, null, { timeout: 10000 });
  const w2OwnId = await page2
    .waitForFunction(() => window.__winId, null, { timeout: 10000 })
    .then((h) => h.jsonValue());
  log('window-2 own id (state.windowId) =', w2OwnId);
  assert(typeof w2OwnId === 'number', 'window-2 must learn its own id from state.windowId');

  // window-1 owns running session S (reuse A). Echo a unique sentinel into it and confirm it
  // lands in window-1's buffer BEFORE the move.
  const sidS = sidA;
  await page1.evaluate(() => {
    window.__cap = '';
  });
  const SB = `SLICEB_${Date.now()}`;
  await page1.evaluate(
    ({ id, s }) => {
      window.__cap = '';
      window.agentDeck.post({ type: 'term:input', sessionId: id, data: `echo ${s}\r` });
    },
    { id: sidS, s: SB },
  );
  const sbInW1 = await page1
    .waitForFunction((s) => (window.__cap || '').includes(s), SB, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  assert(sbInW1, 'Pre-move: sentinel must appear in window-1 buffer (S is live there)');
  log('pre-move: sentinel present in window-1 ✓');

  // Move S from window-1 → window-2. window-2 must mount the same sessionId (no remount that
  // kills ConPTY) and replay the scrollback (attach path).
  await page2.evaluate(() => {
    window.__cap = '';
  });
  await page1.evaluate(
    ({ id, target }) => window.agentDeck.post({ type: 'session:move', sessionId: id, target }),
    { id: sidS, target: { kind: 'window', windowId: w2OwnId } },
  );

  // ASSERT: S appears + is active in window-2, gone from window-1.
  const inW2 = await page2
    .waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sidS, {
      timeout: 15000,
    })
    .then(() => true)
    .catch(() => false);
  assert(inW2, 'After move: window-2 must own session S');
  await page1
    .waitForFunction((id) => !(window.__sessions || []).some((s) => s.id === id), sidS, {
      timeout: 15000,
    })
    .catch(() => {});
  const stillInW1 = await page1.evaluate(
    (id) => (window.__sessions || []).some((s) => s.id === id),
    sidS,
  );
  assert(!stillInW1, 'After move: window-1 must NOT own session S');
  log('PASS move: S moved window-1 → window-2 (gone from w1, present in w2) ✓');

  // ASSERT PTY SURVIVED: window-2's terminal buffer for S contains the PRE-MOVE sentinel
  // (replayed via the attach path) and shows NO "session relaunched" banner.
  const sbReplayed = await page2
    .waitForFunction((s) => (window.__cap || '').includes(s), SB, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  assert(sbReplayed, 'PTY SURVIVED: window-2 buffer must contain the pre-move sentinel (replay)');
  const relaunched = await page2.evaluate(() =>
    (window.__cap || '').includes('session relaunched'),
  );
  assert(!relaunched, 'No relaunch banner: the PTY is the SAME process (not respawned)');
  log('PASS PTY survival: pre-move sentinel replayed in window-2, no relaunch banner ✓');

  // ASSERT LIVE: a SECOND echo after the move lands in window-2 (the PTY is still attached).
  const SB2 = `SLICEB2_${Date.now()}`;
  await page2.evaluate(
    ({ id, s }) =>
      window.agentDeck.post({ type: 'term:input', sessionId: id, data: `echo ${s}\r` }),
    { id: sidS, s: SB2 },
  );
  const liveInW2 = await page2
    .waitForFunction((s) => (window.__cap || '').includes(s), SB2, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  assert(liveInW2, 'LIVE: post-move echo must land in window-2 (PTY still attached, same proc)');
  log('PASS live: post-move echo reached window-2 (PTY still live) ✓');

  await shot(page1, 'multi-window-b-w1.png');
  await shot(page2, 'multi-window-b-w2.png');

  // ASSERT REJECT: move to a bogus window id → error toast, session stays in window-2.
  await page2.evaluate(() => {
    window.__lastError = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'error') window.__lastError = m.message;
    });
  });
  await page2.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'session:move',
        sessionId: id,
        target: { kind: 'window', windowId: 999999 },
      }),
    sidS,
  );
  const gotError = await page2
    .waitForFunction(() => !!window.__lastError, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  assert(gotError, 'REJECT: moving to a bogus window id must surface an error');
  const stillOwned = await page2.evaluate(
    (id) => (window.__sessions || []).some((s) => s.id === id),
    sidS,
  );
  assert(stillOwned, 'REJECT: session must stay in window-2 after a rejected move');
  log('PASS reject: bogus-window move errored, session unchanged ✓');

  log('PASS ✓ multi-window Slice B: live session moved across windows, PTY survived');

  // Re-align the close section below: window-2 now owns the moved session S; kill it there.
  await page2.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sidS);
  await page2
    .waitForFunction(() => (window.__sessions || []).length === 0, null, { timeout: 10000 })
    .catch(() => {});

  // ── Close window 2 → window 1 survives ──────────────────────────────────────
  // Kill B first so the per-window close guard doesn't prompt (no running sessions in w2).
  await page2.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), sidB);
  await page2
    .waitForFunction(() => (window.__sessions || []).length === 0, null, { timeout: 10000 })
    .catch(() => {});
  await app.evaluate((e, id) => e.BrowserWindow.fromId(id)?.close(), win2Id);
  // Poll for window-1-only.
  let oneLeft = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const n = await app.evaluate((e) => e.BrowserWindow.getAllWindows().length).catch(() => -1);
    if (n === 1) {
      oneLeft = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(oneLeft, 'Closing window 2 should leave exactly 1 window (window 1 survives)');
  // Window 1 is still functional. (Session A was moved out to window-2 in the Slice B block
  // and killed there, so window-1 now owns no sessions — it must still be alive + responsive.)
  const aliveAfterClose = await page1.evaluate(() => !!window.agentDeck).catch(() => false);
  assert(aliveAfterClose, 'Window 1 must remain alive + responsive after window 2 closed');
  log('PASS close: window-2 closed, window-1 survives ✓');

  log('PASS ✓ multi-window Slice A: isolation + routing + independent close');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else console.error('[multi-window] ERROR:', e?.message || e);
  process.exit(isAssertion ? 1 : 2);
} finally {
  try {
    await launched?.cleanup();
  } catch {
    /* ignore — teardown flake is acceptable if assertions already passed */
  }
}
