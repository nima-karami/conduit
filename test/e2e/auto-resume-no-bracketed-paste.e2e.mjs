/**
 * auto-resume-no-bracketed-paste — spec 2026-11-13-scheduler-auto-resume §7, "App without bracketed
 * paste". The fake TUI never turns bracketed paste on. The resume message is two lines
 * (autoResumeMessage "first line\nsecond line"):
 *   - the CLI receives ONE line, "first line second line", as plain input — no paste markers, and
 *     the line break is not an Enter that would submit "first line" alone;
 *   - the job's history says "lines joined (no bracketed paste)" (a timed message has no history
 *     to carry it, so the scenario goes through a resume job).
 */
import {
  autoResumeProfile,
  connectServer,
  MARGIN_MS,
  PASTE_START,
  waitForResumeJob,
  waitForSubmits,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, openSession, phase, pollUntil, runScenario } from './harness.mjs';

const RESET_IN_S = 20;
const profile = autoResumeProfile('auto-resume-nopaste', { paste: 'off' });
const { fake } = profile;

await runScenario(
  'auto-resume-no-bracketed-paste',
  async ({ page, log }) => {
    const server = await connectServer(profile.userDataDir);
    try {
      await server.patchSettings({
        autoResumeMarginMs: MARGIN_MS,
        autoResumeMessage: 'first line\nsecond line',
      });
      const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
      const start = await fake.ready();
      assert(start.paste === false, 'the fake turned bracketed paste on');

      phase('limit');
      await fake.cue({ cue: 'limit', resetsInS: RESET_IN_S });
      assert(
        await waitForResumeJob(server, sid, (j) => j.state === 'armed', 15_000),
        'no resume job was armed',
      );

      phase('fire');
      const [submit] = await waitForSubmits(fake, 1, (RESET_IN_S + 40) * 1000, 'the resume');
      assert(
        submit.line === 'first line second line',
        `the CLI submitted ${JSON.stringify(submit.line)}`,
      );
      const raw = fake.raw();
      assert(
        !raw.includes(PASTE_START),
        `paste markers reached a TUI that never asked: ${JSON.stringify(raw)}`,
      );
      assert(
        raw.split('\r').length - 1 === 1 && !raw.includes('\n'),
        `bad line breaks: ${JSON.stringify(raw)}`,
      );
      const again = await pollUntil(() => fake.submits().length > 1, 6_000);
      assert(!again, `delivered more than once: ${JSON.stringify(fake.submits())}`);

      const job = await waitForResumeJob(
        server,
        sid,
        (j) => j.history.some((h) => h.reason === 'lines joined (no bracketed paste)'),
        10_000,
      );
      assert(
        job,
        `the history does not say the lines were joined: ${JSON.stringify((await server.history(sid)).jobs)}`,
      );
      log('one joined line, and the history says so ✓');
    } finally {
      server.close();
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
