/**
 * auto-resume-works-with-no-window — spec 2026-11-13-scheduler-auto-resume §7, "Works with no
 * window" (and §12: the server outlives the windows, ADR 0007). The pattern is
 * mcp-open-windowless: a session is opened, then the app quits, so no window exists at all; the
 * server and the agent keep running.
 *   - the fake Claude hits a limit with a reset 20 s ahead: the hooks reach the server and a resume
 *     job is armed (read over a test C2 client, since there is no window to ask);
 *   - after reset + margin the fake's own log shows "Continue" as one bracketed paste and one Enter.
 */
import {
  autoResumeProfile,
  connectServer,
  MARGIN_MS,
  PASTE_END,
  PASTE_START,
  waitForResumeJob,
  waitForSubmits,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, closeApp, hcTerminalOf, openSession, phase, runScenario } from './harness.mjs';

const RESET_IN_S = 20;
const profile = autoResumeProfile('auto-resume-windowless');
const { fake } = profile;

await runScenario(
  'auto-resume-works-with-no-window',
  async ({ app, page, userDataDir, log }) => {
    const server = await connectServer(userDataDir);
    try {
      await server.patchSettings({ autoResumeMarginMs: MARGIN_MS });
      const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
      await fake.ready();
      const terminal = hcTerminalOf(userDataDir, sid);
      assert(terminal?.address, `no live hc terminal for ${sid}`);

      phase('quit: no window, no app');
      await closeApp(app, page);
      const windows = await app
        .evaluate((e) => e.BrowserWindow.getAllWindows().length)
        .catch(() => 0);
      assert(windows === 0, `${windows} window(s) still open`);
      assert(
        hcTerminalOf(userDataDir, sid)?.address === terminal.address,
        'the agent did not survive the quit',
      );

      phase('limit with no window');
      await fake.cue({ cue: 'limit', resetsInS: RESET_IN_S });
      const { resetsAtMs } = fake.records('LIMIT').at(-1);
      const armed = await waitForResumeJob(server, sid, (j) => j.state === 'armed', 15_000);
      assert(armed, 'no resume job was armed while no window was open');
      assert(
        armed.nextAt === resetsAtMs + MARGIN_MS,
        `armed for the wrong time: ${armed.nextAt} vs ${resetsAtMs + MARGIN_MS}`,
      );
      log('armed with no window ✓');

      phase('fire with no window');
      const [submit] = await waitForSubmits(fake, 1, (RESET_IN_S + 40) * 1000, 'the resume');
      assert(submit.line === 'Continue', `the CLI received ${JSON.stringify(submit.line)}`);
      assert(
        submit.t >= resetsAtMs + MARGIN_MS,
        `"Continue" arrived ${resetsAtMs + MARGIN_MS - submit.t} ms before reset + margin`,
      );
      const raw = fake.raw();
      assert(
        raw.includes(`${PASTE_START}Continue${PASTE_END}`) && raw.split('\r').length - 1 === 1,
        `not one bracketed paste and one Enter: ${JSON.stringify(raw)}`,
      );
      log('delivered after reset + margin with no window ✓');
    } finally {
      server.close();
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
