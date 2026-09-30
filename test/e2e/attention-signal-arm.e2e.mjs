/**
 * Attention signal — the rows that arm, or must not re-arm: a qualifying run then silence
 * (once per episode), acknowledgment then a repaint, a bare BEL, an OSC title ended by BEL,
 * a visible split pane, and a session that exits after output. The never-arm rows are in
 * attention-signal-quiet.e2e.mjs; the setup is in attention-signal-helpers.mjs.
 */

import {
  ARM_LATENCY_MS,
  POLL_MS,
  QUALIFYING_BURST,
  QUIET_OBSERVE_MS,
  runAttentionSignal,
  sleep,
} from './attention-signal-helpers.mjs';
import { assert, clearSpyCalls } from './harness.mjs';

await runAttentionSignal(
  'attention-signal-arm',
  async ({
    app,
    page,
    log,
    sidA,
    sidB,
    sidC,
    needsAttention,
    sessionState,
    waitForAttention,
    assertNeverArms,
    setVisible,
    send,
    acknowledge,
    flashCount,
  }) => {
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
  },
);
