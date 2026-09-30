/**
 * Attention signal — the rows where a background session must NOT arm: a trivial burst, two
 * trivial bursts 3s apart, a spinner, and a mid-turn dribble. The arming rows are in
 * attention-signal-arm.e2e.mjs; the setup is in attention-signal-helpers.mjs.
 */

import { QUIET_OBSERVE_MS, runAttentionSignal, sleep } from './attention-signal-helpers.mjs';

await runAttentionSignal(
  'attention-signal-quiet',
  async ({ page, sidA, sidB, send, assertNeverArms, resync, acknowledge }) => {
    // ── Row: a trivial burst then silence must NOT arm (contract 1) ──────────────
    await send(sidA, 'echo conduit-tiny\r');
    await page.waitForFunction(() => window.__cap.includes('conduit-tiny'), null, {
      timeout: 15000,
    });
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
    await assertNeverArms(
      sidA,
      16_000,
      'dribble with 3s gaps (mid-turn pause), and the quiet after',
    );
    await resync(sidA, 'dribble');
    await acknowledge(sidA, sidB);
  },
);
