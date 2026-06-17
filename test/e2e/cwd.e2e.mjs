/**
 * E2 — Live cd tracking (FULL)
 *
 * With trackCwd ON (default): in a real PowerShell session, cd into a subfolder →
 * assert state for that session shows cwd = the subfolder while projectPath stays
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

import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[cwd] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('cwd');

// A real subfolder inside the repo to cd into.
const SUB_PATH = join(REPO, 'src');

let launched;
try {
  launched = await launchApp();
  const { page } = launched;

  await tapBridge(page);

  // Try PowerShell first, then fall back to powershell (v5).
  // The CWD injection only applies to shell:pwsh and shell:powershell agents.
  const _agents = await page
    .waitForFunction(
      () => {
        // Wait for state to arrive with agents list.
        const sessions = window.__sessions;
        return sessions; // just need agentDeck to have sent state
      },
      null,
      { timeout: 10000 },
    )
    .then(() => null)
    .catch(() => null);

  // Inspect available agents from the state message.
  const _availableAgents = await page.evaluate(() => {
    // The state message carries agents; capture from the subscribe buffer.
    return window.__agentsList || [];
  });

  // Capture agents from state subscription.
  await page.evaluate(() => {
    window.__agentsList = [];
    const unsub = window.agentDeck.subscribe((m) => {
      if (m.type === 'state' && m.agents) {
        window.__agentsList = m.agents.map((a) => a.id);
      }
    });
    window.agentDeck.post({ type: 'ready' });
    setTimeout(unsub, 3000);
  });
  await page.waitForTimeout(1000);
  const agentIds = await page.evaluate(() => window.__agentsList || []);
  log('available agents:', agentIds);

  const psAgent = agentIds.find((id) => id === 'shell:pwsh' || id === 'shell:powershell');

  if (!psAgent) {
    console.log('[cwd] SKIP — no PowerShell shell: agent found (shell:pwsh or shell:powershell)');
    await launched.cleanup();
    process.exit(0);
  }

  log(`using agent: ${psAgent}`);

  // ── Part 1: trackCwd ON → cd updates session.cwd ───────────────────────────
  // Ensure trackCwd is enabled (it's the default).
  await page.evaluate(() => {
    window.agentDeck.post({
      type: 'updateSettings',
      settings: { trackCwd: true },
    });
  });
  await page.waitForTimeout(300);

  const sid = await openSession(page, {
    path: REPO.replace(/\\/g, '/'),
    agentId: psAgent,
  });
  log('opened session:', sid);

  // Wait for the shell to emit its first prompt (initial cwd report).
  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500); // let OSC 9;9 be parsed

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
  await page.waitForTimeout(1500); // let OSC 9;9 propagate to main process + state update

  const cwdAfterCd = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? s.cwd : null;
  }, sid);
  log('session.cwd after cd:', cwdAfterCd);

  // Normalize paths for comparison (the scanner returns forward-slash paths).
  const expectedCwd = SUB_PATH.replace(/\\/g, '/');
  assert(
    cwdAfterCd &&
      (cwdAfterCd === expectedCwd || cwdAfterCd.toLowerCase() === expectedCwd.toLowerCase()),
    `Expected cwd to be "${expectedCwd}" after cd, but got "${cwdAfterCd}"`,
  );
  log('PASS: session.cwd updated after cd ✓');

  // projectPath should still be the repo root.
  const projectPath = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? s.projectPath : null;
  }, sid);
  const expectedProject = REPO.replace(/\\/g, '/');
  assert(
    projectPath &&
      (projectPath === expectedProject ||
        projectPath.toLowerCase() === expectedProject.toLowerCase()),
    `projectPath should remain at repo root "${expectedProject}", got "${projectPath}"`,
  );
  log('PASS: projectPath unchanged ✓');

  // ── Part 2: trackCwd OFF → cd does NOT move cwd ─────────────────────────────
  // Disable trackCwd.
  await page.evaluate(() => {
    window.agentDeck.post({
      type: 'updateSettings',
      settings: { trackCwd: false },
    });
  });
  await page.waitForTimeout(300);

  // Open a new session with trackCwd OFF.
  const sid2 = await openSession(page, {
    path: REPO.replace(/\\/g, '/'),
    agentId: psAgent,
  });
  log('opened second session:', sid2);

  await page.waitForFunction(() => window.__cap.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500);

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
  await page.waitForTimeout(1500);

  const cwdAfterCdOff = await page.evaluate((id) => {
    const s = (window.__sessions || []).find((x) => x.id === id);
    return s ? s.cwd : undefined;
  }, sid2);
  log('session2.cwd after cd (trackCwd off):', cwdAfterCdOff);

  // With trackCwd off, cwd should remain null/undefined or equal to projectPath (not updated).
  const expectedSub2 = sub2.replace(/\\/g, '/');
  const cwdMoved = cwdAfterCdOff && cwdAfterCdOff.toLowerCase() === expectedSub2.toLowerCase();
  assert(!cwdMoved, `cwd should NOT update when trackCwd is off, but got "${cwdAfterCdOff}"`);
  log('PASS: trackCwd off prevents cwd update ✓');

  await launched.cleanup();
  log('PASS ✓ E2 live cd: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[cwd] FAIL ✗', e.message);
    process.exit(1);
  }
  console.error('[cwd] ERROR:', e?.message || e);
  try {
    await launched?.cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
}
