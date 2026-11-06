/**
 * E2 — Live cd tracking (FULL)
 *
 * With trackCwd ON (default): in a real PowerShell session, cd into a subfolder →
 * assert state for that session shows cwd = the subfolder while home stays
 * on the repo root.
 *
 * Toggle trackCwd OFF → cd no longer moves cwd.
 *
 * Windows only (requires PowerShell + ConPTY).
 *
 * NOTE: This test asserts the cwd-tracking path through PowerShell (shell:pwsh or
 * shell:powershell). The OSC 9;9 injection only fires for recognized shell: agents.
 * If neither pwsh nor powershell is available, the test SKIPs gracefully.
 */

import { basename, join } from 'node:path';
import {
  assert,
  finishScenario,
  launchApp,
  makeLog,
  openSession,
  REPO,
  showRightView,
  tapBridge,
  typeLine,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[cwd] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('cwd');

// A real subfolder inside the repo to cd into.
const SUB_PATH = join(REPO, 'src');

let launched;
try {
  launched = await launchApp();
  const { page } = launched;

  await tapBridge(page);

  /** Bounded window for a negative: cwd must not move (UNC refuse / trackCwd off). */
  const observeNothingFor = async (ms, check) => {
    await page.waitForTimeout(ms);
    return check();
  };

  // Capture agents and settings from state subscription.
  await page.evaluate(() => {
    window.__agentsList = [];
    window.__settings = null;
    window.agentDeck.subscribe((m) => {
      if (m.type !== 'state') return;
      if (m.agents) window.__agentsList = m.agents.map((a) => a.id);
      if (m.settings) window.__settings = m.settings;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  await page.waitForFunction(() => (window.__agentsList || []).length > 0, null, {
    timeout: 10000,
  });
  const agentIds = await page.evaluate(() => window.__agentsList || []);
  log('available agents:', agentIds);

  const psAgent = agentIds.find((id) => id === 'shell:pwsh' || id === 'shell:powershell');

  if (!psAgent) {
    console.log('[cwd] SKIP — no PowerShell shell: agent found (shell:pwsh or shell:powershell)');
    await launched.cleanup();
    await finishScenario(0);
  }

  log(`using agent: ${psAgent}`);

  // ── Part 1: trackCwd ON → cd updates session.cwd ───────────────────────────
  // Ensure trackCwd is enabled (it's the default).
  await page.evaluate(() => {
    window.agentDeck.post({
      type: 'updateServerSettings',
      patch: { trackCwd: true },
    });
  });
  await page.waitForFunction(() => window.__settings?.trackCwd === true, null, { timeout: 10000 });

  const sid = await openSession(page, {
    path: REPO.replace(/\\/g, '/'),
    agentId: psAgent,
  });
  log('opened session:', sid);

  // Wait for the shell to emit its first prompt (initial cwd report).
  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });
  await page.waitForFunction(
    (id) => !!(window.__sessions || []).find((x) => x.id === id)?.cwd,
    sid,
    { timeout: 20000 },
  );

  // cd into the subfolder.
  await page.evaluate(
    ({ s, sub }) => {
      window.__cap = '';
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: `cd "${sub}"\r`,
      });
    },
    { s: sid, sub: SUB_PATH },
  );

  // Wait for a new prompt (after cd completes, the prompt hook fires again with the new cwd).
  await page.waitForFunction(() => window.__cap.includes('>') || window.__cap.includes('$'), null, {
    timeout: 15000,
  });
  const expectedCwd = SUB_PATH.replace(/\\/g, '/');
  await page.waitForFunction(
    ({ id, want }) => {
      const cwd = (window.__sessions || []).find((x) => x.id === id)?.cwd;
      return !!cwd && cwd.replace(/\\/g, '/').toLowerCase() === want.toLowerCase();
    },
    { id: sid, want: expectedCwd },
    { timeout: 15000 },
  );

  const cwdAfterCd = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? s.cwd : null;
  }, sid);
  log('session.cwd after cd:', cwdAfterCd);

  // Normalize paths for comparison (the scanner returns forward-slash paths).
  assert(
    cwdAfterCd &&
      (cwdAfterCd === expectedCwd || cwdAfterCd.toLowerCase() === expectedCwd.toLowerCase()),
    `Expected cwd to be "${expectedCwd}" after cd, but got "${cwdAfterCd}"`,
  );
  log('PASS: session.cwd updated after cd ✓');

  // home should still be the repo root.
  const home = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? s.home : null;
  }, sid);
  const expectedProject = REPO.replace(/\\/g, '/');
  assert(
    home && (home === expectedProject || home.toLowerCase() === expectedProject.toLowerCase()),
    `home should remain at repo root "${expectedProject}", got "${home}"`,
  );
  log('PASS: home unchanged ✓');

  // mf-files D1: the Files tab shows the session's folders; it no longer follows the cd.
  await showRightView(page, 'files');
  const homeName = basename(REPO);
  const sectionsAfterCd = await page
    .waitForFunction(
      (name) => {
        const secs = [...document.querySelectorAll('.files-section')];
        const names = secs.map((s) => s.querySelector('.files__root-name')?.textContent ?? '');
        return secs.length === 1 && names[0] === name ? names : null;
      },
      homeName,
      { timeout: 10000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  assert(
    sectionsAfterCd !== null,
    `after cd, Files should still show exactly one section named "${homeName}"`,
  );
  log('PASS: Files sections unchanged by cd ✓');

  // ── Part 1b: a UNC cwd report from terminal output is refused without touching SMB ─────────
  // Plan 2026-10-16-terminal-path-links T2.4: output is untrusted, so the host must not stat a
  // printed `\\host\share` (an SMB connect on the main thread). 192.0.2.1 is TEST-NET-1: it never
  // answers, so a sync stat would block the main thread for the SMB timeout.
  await typeLine(page, sid, "[Console]::Write([char]27 + ']9;9;\\\\192.0.2.1\\share' + [char]7)");
  const t0 = Date.now();
  await launched.app.evaluate(() => 1);
  const roundTrip = Date.now() - t0;
  let roundTripAfter = 0;
  let cwdAfterUnc = null;
  assert(
    await observeNothingFor(3000, async () => {
      const t = Date.now();
      await launched.app.evaluate(() => 1);
      roundTripAfter = Date.now() - t;
      cwdAfterUnc = await page.evaluate((id) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return s ? s.cwd : null;
      }, sid);
      return (
        !!cwdAfterUnc &&
        cwdAfterUnc.toLowerCase() === expectedCwd.toLowerCase() &&
        roundTripAfter < 500
      );
    }),
    `a UNC cwd report must be refused without blocking main (cwd "${cwdAfterUnc}", ${roundTripAfter} ms)`,
  );
  log(
    'session.cwd after UNC report:',
    cwdAfterUnc,
    'main round-trips ms:',
    roundTrip,
    roundTripAfter,
  );
  assert(
    cwdAfterUnc && cwdAfterUnc.toLowerCase() === expectedCwd.toLowerCase(),
    `a UNC cwd report must be refused; cwd moved to "${cwdAfterUnc}"`,
  );
  assert(
    roundTrip < 500 && roundTripAfter < 500,
    `main thread blocked after a UNC report (${roundTrip} ms, ${roundTripAfter} ms)`,
  );
  log('PASS: UNC cwd report refused, main thread responsive ✓');

  // ── Part 2: trackCwd OFF → cd does NOT move cwd ─────────────────────────────
  // Disable trackCwd.
  await page.evaluate(() => {
    window.agentDeck.post({
      type: 'updateServerSettings',
      patch: { trackCwd: false },
    });
  });
  await page.waitForFunction(() => window.__settings?.trackCwd === false, null, { timeout: 10000 });

  // Open a new session with trackCwd OFF.
  const sid2 = await openSession(page, {
    path: REPO.replace(/\\/g, '/'),
    agentId: psAgent,
  });
  log('opened second session:', sid2);

  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });

  // Record the current cwd (should be null or the repo root since trackCwd is off).
  const cwdBefore = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? s.cwd : undefined;
  }, sid2);
  log('session2.cwd before cd (trackCwd off):', cwdBefore);

  // cd into a different subfolder.
  const sub2 = join(REPO, 'electron');
  await page.evaluate(
    ({ s, sub }) => {
      window.__cap = '';
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: `cd "${sub}"\r`,
      });
    },
    { s: sid2, sub: sub2 },
  );
  await page.waitForFunction(() => window.__cap.includes('>') || window.__cap.includes('$'), null, {
    timeout: 15000,
  });
  const expectedSub2 = sub2.replace(/\\/g, '/');
  let cwdAfterCdOff;
  assert(
    await observeNothingFor(1500, async () => {
      cwdAfterCdOff = await page.evaluate((id) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return s ? s.cwd : undefined;
      }, sid2);
      const cwdMoved = cwdAfterCdOff && cwdAfterCdOff.toLowerCase() === expectedSub2.toLowerCase();
      return !cwdMoved;
    }),
    `cwd should NOT update when trackCwd is off, but got "${cwdAfterCdOff}"`,
  );
  log('session2.cwd after cd (trackCwd off):', cwdAfterCdOff);
  log('PASS: trackCwd off prevents cwd update ✓');

  await launched.cleanup();
  log('PASS ✓ E2 live cd: all assertions passed');
  await finishScenario(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[cwd] FAIL ✗', e.message);
    await finishScenario(1);
  }
  console.error('[cwd] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  await finishScenario(2);
}
