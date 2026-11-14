/**
 * auto-resume-cli-resumed-by-itself — spec 2026-11-13-scheduler-auto-resume §7, "CLI resumed by
 * itself". A resume job is armed (reset 20 s ahead, margin 5 s). Before it fires the fake Claude
 * emits Notification quota_auto_resume_fired, as Claude's own auto-resume does:
 *   - at fire time nothing reaches the PTY (no paste, no Enter, no byte of "Continue");
 *   - the job's history ends "skipped: already resumed", with no `sending` entry.
 */
import {
  autoResumeProfile,
  connectServer,
  entryOf,
  MARGIN_MS,
  waitForResumeJob,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, openSession, phase, runScenario } from './harness.mjs';

const RESET_IN_S = 20;
const profile = autoResumeProfile('auto-resume-self');
const { fake } = profile;

await runScenario(
  'auto-resume-cli-resumed-by-itself',
  async ({ page, log }) => {
    const server = await connectServer(profile.userDataDir);
    try {
      await server.patchSettings({ autoResumeMarginMs: MARGIN_MS });
      const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
      await fake.ready();

      phase('armed');
      await fake.cue({ cue: 'limit', resetsInS: RESET_IN_S });
      const { resetsAtMs } = fake.records('LIMIT').at(-1);
      assert(
        await waitForResumeJob(server, sid, (j) => j.state === 'armed', 15_000),
        'no resume job was armed',
      );

      phase('the CLI resumes itself');
      await fake.cue({
        cue: 'hook',
        event: 'Notification',
        notificationType: 'quota_auto_resume_fired',
      });
      const { episodes } = await server.history(sid);
      assert(
        episodes.some((e) => e.state === 'resumed'),
        `the episode is not resumed after quota_auto_resume_fired: ${JSON.stringify(episodes)}`,
      );

      phase('fire time');
      const skipped = await waitForResumeJob(
        server,
        sid,
        (j) => j.state === 'skipped',
        (RESET_IN_S + 40) * 1000,
      );
      assert(skipped, 'the job never reached skipped at fire time');
      assert(
        entryOf(skipped, 'skipped')?.reason === 'already resumed',
        `skipped for the wrong reason: ${JSON.stringify(skipped.history)}`,
      );
      assert(
        !skipped.history.some((h) => h.state === 'sending'),
        `the job went through sending: ${JSON.stringify(skipped.history)}`,
      );
      assert(
        entryOf(skipped, 'skipped').at >= resetsAtMs + MARGIN_MS,
        'the job was skipped before its fire time, so the pre-fire check was not what decided',
      );
      assert(
        fake.submits().length === 0 && fake.pastes().length === 0 && !fake.raw().includes('\r'),
        `bytes reached the PTY at fire time: ${JSON.stringify(fake.raw())}`,
      );
      log('nothing written; history says "skipped: already resumed" ✓');
    } finally {
      server.close();
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
