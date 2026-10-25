/**
 * conduit-mcp-restart — messages and handles survive a quit, and sessions restored at startup get
 * messaging (spec docs/specs/2026-10-25-conduit-mcp-server.md §3.4, §7; plan T11.1 and the
 * conductor's endpoint-wait decision):
 *   run 1: A sends to B while B is busy, so nothing is noticed; quit.
 *   run 2 (same profile, autoRelaunchStale on, so both relaunch at startup): the session selected
 *   at startup mounts with no click and is wired; B reconnects under the same handle, the thread is
 *   intact in the Messages tab, and exactly one notice arrives once B's gate opens. Whether A's
 *   launch actually beats the listen is up to timing; the race itself is pinned by the unit test
 *   "a launch waits for the endpoint" (conduit-mcp-host.test.ts).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  mcpState,
  NOTICE,
  notices,
  openFake,
  records,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, closeApp, launchApp, runScenario, typeLine } from './harness.mjs';

/** Long enough that the send, the check and the quit all land inside B's busy run. */
const BUSY_MS = 30_000;
// Relaunch: the fake spawns its shim and initializes; then the gate wants settle + busy window +
// 3 s quiet + a tick before the notice (see conduit-mcp-gate). Slack covers a loaded runner.
const READY_AFTER_RELAUNCH_MS = 30_000;
const NOTICE_WITHIN_MS = 20_000;
const SUBJECT = 'restart check';

const squash = (s) => s.replace(/\s/g, '');
const busyOf = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id)?.busy === true, sid);

const userDataDir = fakeAgentProfile('conduit-mcp-restart');

await runScenario(
  'conduit-mcp-restart',
  async ({ app, page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'conduit-mcp-restart-'));
    const a = await openFake(page, work);
    const b = await openFake(page, work);
    log(`run 1: A=${a.handle} B=${b.handle}`);
    await sleep(4_000);

    await typeLine(page, b.sessionId, `busy ${BUSY_MS}`);
    assert(await until(() => busyOf(page, b.sessionId), 5_000), 'B never read busy');
    const sent = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      subject: SUBJECT,
      body: 'survive the restart',
    });
    assert(sent.recipients?.[0]?.status === 'queued', `send: ${JSON.stringify(sent)}`);
    const threadId = sent.thread_id;
    await sleep(1_000);
    assert(notices(b.sessionId).length === 0, 'B was noticed while busy, before the quit');
    const readyBefore = records(b.sessionId, 'READY').length;
    const readyBeforeA = records(a.sessionId, 'READY').length;

    await closeApp(app, page);
    const settingsPath = join(userDataDir, 'settings.json');
    const blob = existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, 'utf8'))
      : { version: 1, settings: {} };
    blob.settings = { ...blob.settings, restoreSessions: true, autoRelaunchStale: true };
    writeFileSync(settingsPath, JSON.stringify(blob));
    // Startup selects the first restored session and mounts its pane; keeping only A and B, A
    // first, makes that a fake, so its launch is one no click triggers.
    const sessionsPath = join(userDataDir, 'sessions.json');
    const saved = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const byId = new Map((saved.sessions ?? []).map((s) => [s.id, s]));
    assert(byId.has(a.sessionId) && byId.has(b.sessionId), 'A or B missing from sessions.json');
    saved.sessions = [byId.get(a.sessionId), byId.get(b.sessionId)];
    writeFileSync(sessionsPath, JSON.stringify(saved));

    const second = await launchApp({ userDataDir });
    try {
      const p2 = second.page;
      await tapMcp(p2);
      // The selected session's pane mounts at startup, before any click: that launch is the one
      // that can run ahead of the endpoint's listen.
      const activeCard = p2.locator('.session.session--active');
      await activeCard.waitFor({ timeout: 10_000 });
      const startupId = await activeCard.getAttribute('data-sessionid');
      const startup = [a, b].find((s) => s.sessionId === startupId);
      assert(startup, `the session selected at startup is neither A nor B: ${startupId}`);
      const startupBefore = startup === a ? readyBeforeA : readyBefore;
      const startupWired = await until(
        () =>
          records(startup.sessionId, 'READY')
            .slice(startupBefore)
            .some((r) => r.tools.includes('read_inbox')),
        READY_AFTER_RELAUNCH_MS,
      );
      assert(startupWired, `${startup.handle}, mounted at startup, has no READY with tools`);
      const st0 = await mcpState(p2);
      const startupBadge = st0?.sessions?.[startup.sessionId];
      assert(
        startupBadge?.unavailable === null,
        `${startup.handle} unavailable after startup: ${startupBadge?.unavailable}`,
      );
      log(`run 2: ${startup.handle} was wired at startup with no click`);

      // autoRelaunchStale marks the restored sessions running at startup; a terminal starts when
      // its pane mounts, so showing B is what spawns it.
      await p2.locator(`.session[data-sessionid="${b.sessionId}"]`).click();
      const reconnected = await until(
        () =>
          records(b.sessionId, 'READY')
            .slice(readyBefore)
            .some((r) => r.tools.includes('read_inbox')),
        READY_AFTER_RELAUNCH_MS,
      );
      assert(reconnected, 'B did not relaunch with messaging wired (no READY with tools)');
      const st = await mcpState(p2);
      const badge = st?.sessions?.[b.sessionId];
      assert(badge?.handle === b.handle, `B's handle after restart: ${badge?.handle}`);
      assert(badge?.unavailable === null, `B unavailable after restart: ${badge?.unavailable}`);
      assert(
        (st?.threads ?? []).some((t) => t.threadId === threadId),
        `thread ${threadId} missing after restart`,
      );

      await p2.locator('.rightpane .rtab', { hasText: 'Messages' }).click();
      await p2.locator('.mcpmsg [role="option"]', { hasText: SUBJECT }).waitFor({ timeout: 5_000 });

      const noticed = await until(() => notices(b.sessionId).length > 0, NOTICE_WITHIN_MS);
      const gate = (await mcpState(p2))?.sessions?.[b.sessionId]?.gate;
      assert(noticed, `no notice for B after the restart (gate: ${gate})`);
      assert(
        squash(notices(b.sessionId)[0].line) === squash(NOTICE),
        `notice text: ${notices(b.sessionId)[0].line}`,
      );
      // Exactly one: the queued state restored from the log and B's reconnect must not each
      // produce a notice, and a re-sent notice would mean the restored state lost its `noticed`.
      await sleep(4_000);
      assert(notices(b.sessionId).length === 1, 'more than one notice after the restart');
      log(`run 2: ${b.handle} reconnected and was noticed once`);
    } finally {
      await second.cleanup().catch(() => {});
    }
  },
  { userDataDir },
);
