/**
 * auto-resume-server-restart — spec 2026-11-13-scheduler-auto-resume §7, "Server restart between
 * arm and fire". A resume job is armed (reset 8 s ahead, margin 5 s); the app quits and the
 * server is restarted over C2 (`server.restart`), which the supervisor does not undo while no app
 * is there to start a new one, so the server stays down while the fire time passes. The agent
 * survives the restart (it is an hc terminal). Then the app is relaunched on the same profile:
 *   - scheduler.json carried the armed job across;
 *   - nothing was delivered while the server was down;
 *   - after the start the job fires ONCE, and its history says it was late and was checked first
 *     (`checking: late`, then `sending`), so the pre-fire check ran on the restored episode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_VERSION,
  autoResumeProfile,
  connectServer,
  entryOf,
  MARGIN_MS,
  untilClock,
  waitForResumeJob,
  waitForSubmits,
  workFolder,
} from './auto-resume-helpers.mjs';
import { C2 } from './c2-peer.mjs';
import {
  assert,
  closeApp,
  hcTerminalOf,
  launchApp,
  openSession,
  phase,
  pollUntil,
  runScenario,
} from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';

const RESET_IN_S = 8;
/** `Scheduler` calls a fire late past this much overdue (src/timed-messages.ts LATE_GRACE_MS). */
const LATE_GRACE_MS = 30_000;
const profile = autoResumeProfile('auto-resume-restart');
const { fake } = profile;

/** `server.restart` from a test client; resolves once the connection has closed. */
async function restartServer(endpoint) {
  const c2 = await C2.open(endpoint);
  const closed = new Promise((resolve) => c2.socket.once('close', resolve));
  await c2.call('hello', { appVersion: APP_VERSION, generation: SERVER_PROTOCOL_GENERATION });
  // The server may drop the connection before it answers, which C2 reports as a rejection.
  const outcome = c2.call('server.restart', { reason: 'user' }).then(
    (result) => ({ result }),
    (error) => ({ error: error.message }),
  );
  await closed;
  return outcome;
}

await runScenario(
  'auto-resume-server-restart',
  async ({ app, page, userDataDir, log }) => {
    let server = await connectServer(userDataDir);
    let second = null;
    try {
      await server.patchSettings({ autoResumeMarginMs: MARGIN_MS });
      const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
      await fake.ready();
      const terminal = hcTerminalOf(userDataDir, sid);
      assert(terminal?.address, `no live hc terminal for ${sid}`);

      phase('armed');
      await fake.cue({ cue: 'limit', resetsInS: RESET_IN_S });
      const { resetsAtMs } = fake.records('LIMIT').at(-1);
      const fireAt = resetsAtMs + MARGIN_MS;
      assert(
        await waitForResumeJob(server, sid, (j) => j.state === 'armed', 15_000),
        'no resume job was armed',
      );
      // The server writes scheduler.json behind a debounce; a restart before it lands loses the job.
      const schedulerFile = join(userDataDir, 'scheduler.json');
      assert(
        await pollUntil(
          () =>
            existsSync(schedulerFile) &&
            JSON.parse(readFileSync(schedulerFile, 'utf8')).jobs.some(
              (j) => j.trigger.kind === 'limit-reset' && j.state === 'armed',
            ),
          15_000,
        ),
        'scheduler.json never held the armed job',
      );
      server.close();

      phase('restart with the fire time inside it');
      await closeApp(app, page);
      const reply = await restartServer(
        teardownNames(userDataDir, process.platform, tmpdir()).serverEndpoint,
      );
      log(`server.restart reply: ${JSON.stringify(reply)}`);
      assert(
        !reply.error || /closed/i.test(reply.error),
        `server.restart failed: ${JSON.stringify(reply)}`,
      );
      // Down past the fire time by more than the late grace, so the fire is late by the clock too.
      assert(
        await untilClock(fireAt + LATE_GRACE_MS + 1_000),
        'the clock never passed the fire time',
      );
      assert(fake.submits().length === 0, 'the message was delivered while the server was down');
      assert(
        hcTerminalOf(userDataDir, sid)?.address === terminal.address,
        'the agent did not survive the server restart',
      );

      phase('relaunch');
      second = await launchApp({ userDataDir, env: profile.env, openFolder: false });
      server = await connectServer(userDataDir);
      const [submit] = await waitForSubmits(fake, 1, 90_000, 'the late resume');
      assert(submit.line === 'Continue', `the CLI received ${JSON.stringify(submit.line)}`);
      assert(submit.t > fireAt + LATE_GRACE_MS, 'it was not delivered after the restart');

      phase('history');
      const job = await waitForResumeJob(
        server,
        sid,
        (j) => j.history.some((h) => h.state === 'sending'),
        15_000,
      );
      assert(
        job,
        `no job record of the delivery: ${JSON.stringify((await server.history(sid)).jobs)}`,
      );
      const states = job.history.map((h) => h.state);
      assert(
        entryOf(job, 'checking')?.reason === 'late' &&
          states.indexOf('checking') < states.indexOf('sending') &&
          states.filter((s) => s === 'sending').length === 1,
        `expected checking(late) then one sending: ${JSON.stringify(job.history)}`,
      );
      const again = await pollUntil(() => fake.submits().length > 1, 8_000);
      assert(!again, `it fired more than once: ${JSON.stringify(fake.submits())}`);
      log('fired once after the restart, flagged late, after the pre-fire check ✓');
    } finally {
      server.close();
      if (second) await second.cleanup().catch(() => {});
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
