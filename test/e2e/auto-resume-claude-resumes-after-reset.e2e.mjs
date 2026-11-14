/**
 * auto-resume-claude-resumes-after-reset — spec 2026-11-13-scheduler-auto-resume §7, "Claude-shaped
 * session resumes after reset". A fake Claude (fixtures/fake-claude-hooks.mjs, launched with the
 * `--settings` Conduit writes) runs the configured hooks and status line like Claude does:
 *   - a status line with five_hour.resets_at 30 s ahead, then a StopFailure rate_limit hook, with
 *     autoResumeMarginMs 5000, arms one resume job at resetAt + 5000;
 *   - once that time has passed the fake's own log shows "Continue" as ONE bracketed paste and ONE
 *     Enter, never before resetAt + margin and never twice;
 *   - when the fake then emits UserPromptSubmit, the job is done.
 */
import {
  autoResumeProfile,
  connectServer,
  entryOf,
  MARGIN_MS,
  PASTE_END,
  PASTE_START,
  waitForResumeJob,
  waitForSubmits,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, openSession, phase, pollUntil, runScenario } from './harness.mjs';

const RESET_IN_S = 30;
const profile = autoResumeProfile('auto-resume-claude');
const { fake } = profile;

await runScenario(
  'auto-resume-claude-resumes-after-reset',
  async ({ page, log }) => {
    const server = await connectServer(profile.userDataDir);
    try {
      await server.patchSettings({ autoResumeMarginMs: MARGIN_MS });

      phase('session');
      const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
      const start = await fake.ready();
      assert(
        start.argv.includes('--settings') && start.hookEvents.includes('StopFailure'),
        `Conduit did not launch the fake with its --settings hooks: ${JSON.stringify(start)}`,
      );

      phase('limit');
      await fake.cue({ cue: 'limit', resetsInS: RESET_IN_S });
      const { resetsAtMs } = fake.records('LIMIT').at(-1);
      const armed = await waitForResumeJob(server, sid, (j) => j.state === 'armed', 15_000);
      assert(armed, 'no resume job was armed after the StopFailure hook and status line');
      assert(
        armed.trigger.resetAt === resetsAtMs && armed.nextAt === resetsAtMs + MARGIN_MS,
        `the job is not armed at resetAt + margin: ${JSON.stringify({ trigger: armed.trigger, nextAt: armed.nextAt, resetsAtMs })}`,
      );
      assert(fake.submits().length === 0, 'something was written to the PTY before the reset');
      log(`armed at resetAt + ${MARGIN_MS} ms ✓`);

      phase('fire');
      const [submit] = await waitForSubmits(fake, 1, (RESET_IN_S + 40) * 1000, 'the resume');
      assert(submit.line === 'Continue', `the CLI received ${JSON.stringify(submit.line)}`);
      assert(
        submit.t >= resetsAtMs + MARGIN_MS,
        `"Continue" arrived ${resetsAtMs + MARGIN_MS - submit.t} ms before reset + margin`,
      );
      const raw = fake.raw();
      assert(
        raw.includes(`${PASTE_START}Continue${PASTE_END}`),
        `"Continue" was not one bracketed paste: ${JSON.stringify(raw)}`,
      );
      assert(
        raw.split('\r').length - 1 === 1,
        `expected exactly one Enter, got ${JSON.stringify(raw)}`,
      );
      // A duplicate delivery would follow within the writer's few seconds, not minutes later.
      const again = await pollUntil(() => fake.submits().length > 1, 8_000);
      assert(!again, `the message was delivered more than once: ${JSON.stringify(fake.submits())}`);
      log('"Continue" + Enter arrived exactly once, after reset + margin ✓');

      phase('resumed');
      const verifying = await waitForResumeJob(server, sid, (j) => j.state === 'verifying', 10_000);
      assert(verifying, 'the job is not verifying after the delivery');
      await fake.cue({ cue: 'hook', event: 'UserPromptSubmit' });
      const done = await waitForResumeJob(server, sid, (j) => j.state === 'done', 15_000);
      assert(done, 'the job is not done after the UserPromptSubmit hook');
      assert(
        entryOf(done, 'done')?.reason === 'resumed',
        `done for the wrong reason: ${JSON.stringify(done.history)}`,
      );
      log('UserPromptSubmit closed the job ✓');
    } finally {
      server.close();
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
