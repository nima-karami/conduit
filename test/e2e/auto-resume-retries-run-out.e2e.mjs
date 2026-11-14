/**
 * auto-resume-retries-run-out — spec 2026-11-13-scheduler-auto-resume §7, "Retries run out".
 * autoResumeMaxAttempts is 2 and the fake Claude emits a StopFailure (after a fresh status line
 * with a reset 8 s ahead) every time it receives a prompt, and no UserPromptSubmit:
 *   - the first delivery re-arms the job ("limited again") for the new reset + margin;
 *   - the second delivery is the last: the job fails with "still limited" and the session shows
 *     needs-you ("stuck") with that reason;
 *   - no third delivery is made.
 */
import {
  autoResumeProfile,
  connectServer,
  entryOf,
  MARGIN_MS,
  sessionOf,
  waitForResumeJob,
  waitForSubmits,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, openSession, phase, pollUntil, runScenario } from './harness.mjs';

const profile = autoResumeProfile('auto-resume-retries');
const { fake } = profile;

await runScenario(
  'auto-resume-retries-run-out',
  async ({ page, log }) => {
    const server = await connectServer(profile.userDataDir);
    try {
      await server.patchSettings({ autoResumeMarginMs: MARGIN_MS, autoResumeMaxAttempts: 2 });
      const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
      await fake.ready();
      await fake.cue({ cue: 'config', onSubmit: 'limit', resetsInS: 8 });

      phase('limit');
      await fake.cue({ cue: 'limit', resetsInS: 10 });
      assert(
        await waitForResumeJob(server, sid, (j) => j.state === 'armed', 15_000),
        'no resume job was armed',
      );

      phase('two deliveries');
      // 10 s + 5 s to the first, then 8 s + 5 s to the second, plus the writer and the hooks.
      const submits = await waitForSubmits(fake, 2, 90_000, 'both deliveries');
      assert(
        submits.every((s) => s.line === 'Continue'),
        `unexpected deliveries: ${JSON.stringify(submits)}`,
      );

      phase('failed');
      const failed = await waitForResumeJob(server, sid, (j) => j.state === 'failed', 30_000);
      assert(failed, `the job did not fail: ${JSON.stringify((await server.history(sid)).jobs)}`);
      assert(
        entryOf(failed, 'failed')?.reason === 'still limited' && failed.attempts === 2,
        `failed for the wrong reason or after the wrong attempts: ${JSON.stringify(failed)}`,
      );
      assert(
        failed.history.some((h) => h.state === 'armed' && h.reason === 'limited again'),
        `the first delivery did not re-arm: ${JSON.stringify(failed.history)}`,
      );
      const stuck = await pollUntil(async () => {
        const s = await sessionOf(page, sid);
        return s?.attentionReason === 'stuck' && /still limited/i.test(s.stuckReason ?? '')
          ? s
          : null;
      }, 15_000);
      assert(
        stuck,
        `the session does not show needs-you with "still limited": ${JSON.stringify(await sessionOf(page, sid))}`,
      );
      log(`needs you: ${stuck.stuckReason} ✓`);

      phase('no third delivery');
      const third = await pollUntil(() => fake.submits().length > 2, 12_000);
      assert(!third, `a third delivery was made: ${JSON.stringify(fake.submits())}`);
      log('two deliveries, none after the last ✓');
    } finally {
      server.close();
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
