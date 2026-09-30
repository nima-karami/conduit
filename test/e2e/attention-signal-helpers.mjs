/**
 * Shared driver for the attention-signal scenarios — the behavioural acceptance matrix of
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
  finishScenario,
  getSpyCalls,
  launchApp,
  makeLog,
  openSession,
  REPO,
  spyMain,
  tapBridge,
} from './harness.mjs';

// Arming latency = ATTENTION_QUIET_MS (4000) + up to one 750 ms sweep. The waits below
// allow generous multiples: this suite shares a machine with other Electrons.
export const ARM_LATENCY_MS = 4750;
const SETTLE_MS = 400;
export const POLL_MS = 250;
/** Long enough that an arm would certainly have happened if it were going to. */
export const QUIET_OBSERVE_MS = 10_000;
/** SPAWN_GRACE_MS (5000) plus margin — output before this is discarded as startup noise. */
const SPAWN_GRACE_WAIT_MS = 6500;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A run that qualifies by BYTES (>= MIN_RUN_BYTES) in one fast burst.
export const QUALIFYING_BURST = `node -e "process.stdout.write('x'.repeat(4000)+String.fromCharCode(10))"\r`;

/**
 * Launches the app with three idle shells past their spawn grace, runs `rows`, and exits.
 * @param {string} name
 * @param {(ctx: Record<string, any>) => Promise<void>} rows
 */
export async function runAttentionSignal(name, rows) {
  if (process.platform !== 'win32') {
    console.log(`[${name}] SKIP — suite is Windows-only`);
    await finishScenario(0);
  }

  const log = makeLog(name);

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
      page.evaluate(
        (id) => (window.__sessions || []).find((x) => x.id === id)?.status ?? null,
        sid,
      );

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
      await page.waitForFunction((t) => window.__cap.includes(t), `${tag}-ok`, {
        timeout: 40000,
      });
    };

    /** Acknowledge a background session (the user looks at it, then switches back). */
    const acknowledge = async (sid, activeSid) => {
      await setVisible([sid]);
      await setVisible([activeSid]);
    };

    const flashCount = async () =>
      (await getSpyCalls(app)).filter((c) => c.api === 'flashFrame' && c.args[0] === true).length;

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

    await rows({
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
      resync,
      acknowledge,
      flashCount,
    });

    await launched.cleanup();
    log('PASS ✓ attention signal matrix: all rows passed');
    await finishScenario(0);
  } catch (e) {
    const isAssertion = e?.name === 'AssertionError';
    if (isAssertion) {
      console.log(`[${name}] FAIL ✗`, e.message);
    } else {
      console.error(`[${name}] ERROR:`, e?.message || e);
      if (e?.stack) console.error(e.stack);
    }
    try {
      await launched?.cleanup();
    } catch {
      /* already gone */
    }
    await finishScenario(isAssertion ? 1 : 2);
  }
}
