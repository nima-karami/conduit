/**
 * Attention signal quality — the behavioural acceptance matrix of
 * docs/specs/2026-08-21-attention-signal-quality.md, driven against the real app with
 * scripted PTY children.
 *
 * Runs HIDDEN (the runner's CONDUIT_E2E=1): every row asserted here reads the
 * `needsAttention` flag off the state broadcast, which does not depend on window focus.
 * The OS-surface rows (taskbar flash / notification, which DO need a real focusable
 * window) stay in attention.e2e.mjs.
 *
 * Session visibility is posted directly as the `visible` protocol message — the same
 * message the renderer's own effect sends when the active session or split changes. It
 * stands in for the user switching sessions, without depending on sidebar markup.
 */

import {
  assert,
  clearSpyCalls,
  getSpyCalls,
  launchApp,
  makeLog,
  openSession,
  REPO,
  spyMain,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[attention-signal] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('attention-signal');

// Arming latency = ATTENTION_QUIET_MS (4000) + up to one 750 ms sweep. The waits below
// allow generous multiples: this suite shares a machine with other Electrons.
const ARM_LATENCY_MS = 4750;
const SETTLE_MS = 400;
const POLL_MS = 250;
/** Long enough that an arm would certainly have happened if it were going to. */
const QUIET_OBSERVE_MS = 10_000;
/** SPAWN_GRACE_MS (5000) plus margin — output before this is discarded as startup noise. */
const SPAWN_GRACE_WAIT_MS = 6500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;
  await spyMain(app, [{ api: 'flashFrame' }]);
  await tapBridge(page);

  const needsAttention = (sid) =>
    page.evaluate((id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return !!s?.needsAttention;
    }, sid);

  /** The session's lifecycle status, or null when it is no longer listed at all. */
  const sessionState = (sid) =>
    page.evaluate((id) => (window.__sessions || []).find((x) => x.id === id)?.status ?? null, sid);

  /** Poll until the session is flagged; returns how long that took, or null on timeout. */
  const waitForAttention = async (sid, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await needsAttention(sid)) return Date.now() - start;
      await sleep(POLL_MS);
    }
    return null;
  };

  /** Watch for `ms`, failing the moment the session gets flagged. */
  const assertNeverArms = async (sid, ms, what) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      assert(!(await needsAttention(sid)), `${what}: must NOT arm attention`);
      await sleep(POLL_MS);
    }
    log(`PASS: ${what} — no badge after ${((Date.now() - start) / 1000).toFixed(1)}s ✓`);
  };

  const setVisible = async (ids) => {
    await page.evaluate((v) => window.agentDeck.post({ type: 'visible', ids: v }), ids);
    await sleep(SETTLE_MS);
  };

  const send = (sid, data) =>
    page.evaluate(
      ({ s, d }) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: d }),
      { s: sid, d: data },
    );

  /**
   * Wait until the session's child has exited and cmd is back at a prompt. The marker is
   * CONCATENATED in the child so the shell's echo of the command line cannot contain it —
   * waiting on a literal that appears in the typed text proves nothing.
   */
  const resync = async (sid, tag) => {
    await send(sid, `node -e "console.log('${tag}'+'-ok')"\r`);
    await page.waitForFunction((t) => window.__cap.includes(t), `${tag}-ok`, { timeout: 40000 });
  };

  /** Acknowledge a background session (the user looks at it, then switches back). */
  const acknowledge = async (sid, activeSid) => {
    await setVisible([sid]);
    await setVisible([activeSid]);
  };

  const flashCount = async () =>
    (await getSpyCalls(app)).filter((c) => c.api === 'flashFrame' && c.args[0] === true).length;

  // A run that qualifies by BYTES (>= MIN_RUN_BYTES) in one fast burst.
  const QUALIFYING_BURST = `node -e "process.stdout.write('x'.repeat(4000)+String.fromCharCode(10))"\r`;

  // sidB is opened LAST so it is the active session the renderer reports as visible;
  // sidA and sidC are the background sessions under test.
  const repo = REPO.replace(/\\/g, '/');
  const sidA = await openSession(page, { path: repo, agentId: 'shell:cmd' });
  const sidC = await openSession(page, { path: repo, agentId: 'shell:cmd' });
  const sidB = await openSession(page, { path: repo, agentId: 'shell:cmd' });
  log('sessions:', { sidA, sidB, sidC });

  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });
  await setVisible([sidB]);
  // Every session is inside its spawn grace right now; wait it out so the rows below
  // measure real work rather than shell banners.
  await sleep(SPAWN_GRACE_WAIT_MS);

  // ── Row: a trivial burst then silence must NOT arm (contract 1) ──────────────
  await send(sidA, 'echo conduit-tiny\r');
  await page.waitForFunction(() => window.__cap.includes('conduit-tiny'), null, { timeout: 15000 });
  await assertNeverArms(sidA, QUIET_OBSERVE_MS, 'trivial burst then quiet');

  // ── Row: two unrelated trivial bursts must NOT merge into one qualifying run ──
  // Each is its own run: the gap between them exceeds the busy window, so neither
  // inherits the other's elapsed time (spec contract 1, "a run starts at the first
  // output after idle"). Without that, two `echo`s 3s apart look like a 3s run.
  await acknowledge(sidA, sidB);
  await send(sidA, 'echo conduit-gap-one\r');
  await page.waitForFunction(() => window.__cap.includes('conduit-gap-one'), null, {
    timeout: 15000,
  });
  await sleep(3000);
  await send(sidA, 'echo conduit-gap-two\r');
  await page.waitForFunction(() => window.__cap.includes('conduit-gap-two'), null, {
    timeout: 15000,
  });
  await assertNeverArms(sidA, QUIET_OBSERVE_MS, 'two trivial bursts 3s apart');

  // ── Row: a spinner (small write every 300 ms) must NOT arm while it runs ─────
  await send(
    sidA,
    `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('.');if(++i>=24)clearInterval(t)},300)"\r`,
  );
  await assertNeverArms(sidA, 9000, 'spinner still working');
  await resync(sidA, 'spin');
  await acknowledge(sidA, sidB); // drop the spinner's accumulated run

  // ── Row: a mid-turn tool pause (gaps > the busy window) must NOT arm ─────────
  // Each gap exceeds the busy window, so every tick is its own trivial run and none
  // of them qualifies — not while the child prints, and not after it stops either.
  // The observation deliberately outlives the child (4 ticks ≈ 9s) plus the arming
  // latency, so it also covers the quiet that follows the last tick.
  await send(
    sidA,
    `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('tick'+String.fromCharCode(10));if(++i>=4)clearInterval(t)},3000)"\r`,
  );
  await assertNeverArms(sidA, 16_000, 'dribble with 3s gaps (mid-turn pause), and the quiet after');
  await resync(sidA, 'dribble');
  await acknowledge(sidA, sidB);

  // ── Row: a qualifying run then silence arms; a later dribble does not re-fire ─
  await clearSpyCalls(app);
  await send(sidA, QUALIFYING_BURST);
  const armedIn = await waitForAttention(sidA, ARM_LATENCY_MS * 3);
  assert(armedIn !== null, 'a qualifying run followed by silence must arm attention');
  log(`PASS: qualifying run armed after ${(armedIn / 1000).toFixed(1)}s ✓`);
  const flashesAfterArm = await flashCount();
  log('flashFrame(true) after the first arm:', flashesAfterArm);
  if (flashesAfterArm === 0) {
    log('NOTE: no OS flash observed (a window held focus) — OS-surface rows rely on it');
  }

  // Second quiet cycle with no acknowledgment: the episode latch must hold.
  await send(sidA, 'echo conduit-repaint\r');
  await sleep(QUIET_OBSERVE_MS);
  const flashesAfterRepaint = await flashCount();
  assert(
    flashesAfterRepaint === flashesAfterArm,
    `attention must fire once per episode; flashFrame(true) went ${flashesAfterArm} -> ${flashesAfterRepaint}`,
  );
  assert(await needsAttention(sidA), 'an unacknowledged session stays flagged');
  log('PASS: no re-fire on a second quiet cycle ✓');

  // ── Row: acknowledged, then a small repaint — must not re-arm (CC statusline) ─
  await setVisible([sidA]);
  assert(!(await needsAttention(sidA)), 'seeing a session must clear its badge');
  await setVisible([sidB]);
  await send(sidA, 'echo conduit-statusline\r');
  await page.waitForFunction(() => window.__cap.includes('conduit-statusline'), null, {
    timeout: 15000,
  });
  await assertNeverArms(sidA, QUIET_OBSERVE_MS, 'acknowledged then small repaint');

  // ── Row: a bare BEL arms immediately, with no quiet wait (contract 2) ────────
  await send(sidA, `node -e "process.stdout.write(String.fromCharCode(7))"\r`);
  const bellIn = await waitForAttention(sidA, ARM_LATENCY_MS * 2);
  assert(bellIn !== null, 'a bare BEL must arm attention');
  log(`PASS: bare BEL armed after ${(bellIn / 1000).toFixed(1)}s ✓`);

  // ── Row: an OSC title terminated by BEL must NOT arm (the named failure) ─────
  await acknowledge(sidA, sidB);
  await send(
    sidA,
    `node -e "process.stdout.write(String.fromCharCode(27)+']0;conduit-title'+String.fromCharCode(7))"\r`,
  );
  await assertNeverArms(sidA, QUIET_OBSERVE_MS, 'OSC title terminated by BEL');

  // ── Row: a split-pane session finishing a qualifying run on screen (contract 4)
  await setVisible([sidB, sidA]); // sidA is now the split pane — the user can see it
  await send(sidA, QUALIFYING_BURST);
  await assertNeverArms(sidA, QUIET_OBSERVE_MS, 'qualifying run in a visible split pane');
  await setVisible([sidB]);

  // ── Row: a session that exits after output raises no "finished" (contract 6) ──
  // sidC is live and tracked going in, so "not flagged" below is a real observation.
  assert(await sessionState(sidC), 'sidC must be a live session before the exit row');
  const flashesBeforeExit = await flashCount();
  await send(sidC, `node -e "process.stdout.write('y'.repeat(4000))" & exit\r`);
  // Prove the exit actually happened, or the row asserts nothing about exiting. A plain
  // shell with no open editors is CLOSED by the renderer when its process ends
  // (src/close-decision.ts sessionExitAction), so "gone from the list" is the expected
  // landing state here and "exited" is the transient one — accept either.
  const exited = await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const st = await sessionState(sidC);
      if (st === null || st === 'exited') return st ?? 'closed';
      await sleep(POLL_MS);
    }
    return null;
  })();
  assert(exited !== null, 'sidC should have exited (or been closed) after `exit`');
  log(`sidC after exit: ${exited}`);
  await assertNeverArms(sidC, QUIET_OBSERVE_MS, 'session that exited after output');
  const flashesAfterExit = await flashCount();
  assert(
    flashesAfterExit === flashesBeforeExit,
    `an exited session must raise no OS attention; flashFrame(true) went ${flashesBeforeExit} -> ${flashesAfterExit}`,
  );

  await launched.cleanup();
  log('PASS ✓ attention signal matrix: all rows passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[attention-signal] FAIL ✗', e.message);
  } else {
    console.error('[attention-signal] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    await launched?.cleanup();
  } catch {
    /* already gone */
  }
  process.exit(isAssertion ? 1 : 2);
}
