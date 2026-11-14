/**
 * auto-resume-codex-session-log — spec 2026-11-13-scheduler-auto-resume §7, "Codex-shaped session
 * from its session log". A fake Codex (a launcher named `codex`, so the host binds the Codex adapter
 * by the command's leaf) runs in a session whose CODEX_HOME is inside the profile. The scenario
 * plays Codex's writer: it creates `sessions/YYYY/MM/DD/rollout-*.jsonl` with a primary
 * `session_meta` for the session's folder (no parent_thread_id), then appends
 *   - task_complete with error usage_limit_exceeded (no reset time in it), and
 *   - token_count with a primary window at 100 % and resets_at 10 minutes ahead.
 * The Limit monitor must arm one resume job at resets_at + margin, from the rollout alone: the
 * fake prints no limit notice, so rules cannot be what armed it.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  autoResumeProfile,
  connectServer,
  MARGIN_MS,
  waitForResumeJob,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, openSession, phase, runScenario } from './harness.mjs';

const RESET_IN_S = 600;
const profile = autoResumeProfile('auto-resume-codex', { as: 'codex' });
const { fake } = profile;

const two = (n) => String(n).padStart(2, '0');
const jsonl = (o) => `${JSON.stringify(o)}\n`;

await runScenario(
  'auto-resume-codex-session-log',
  async ({ page, log }) => {
    const server = await connectServer(profile.userDataDir);
    try {
      await server.patchSettings({ autoResumeMarginMs: MARGIN_MS });
      const work = workFolder();
      const sid = await openSession(page, { path: work, agentId: profile.agentId });
      await fake.ready();

      phase('rollout');
      // The host watches the LOCAL date's folder (and the next day's): spike S3.
      const now = new Date();
      const folder = join(
        profile.codexHome,
        'sessions',
        String(now.getFullYear()),
        two(now.getMonth() + 1),
        two(now.getDate()),
      );
      mkdirSync(folder, { recursive: true });
      const threadId = '01a1d190-1af2-7db3-ae44-cb9dacc349ed';
      const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
      const file = join(folder, `rollout-${stamp}-${threadId}.jsonl`);
      writeFileSync(
        file,
        jsonl({
          timestamp: now.toISOString(),
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: now.toISOString(),
            cwd: work,
            originator: 'codex_cli_rs',
            cli_version: '0.145.0',
            source: 'cli',
          },
        }),
      );
      appendFileSync(
        file,
        jsonl({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            error: {
              message: "You've hit your usage limit.",
              codex_error_info: 'usage_limit_exceeded',
            },
          },
        }),
      );
      const resetsAtSec = Math.floor(Date.now() / 1000) + RESET_IN_S;
      appendFileSync(
        file,
        jsonl({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              limit_id: 'codex',
              primary: { used_percent: 100, window_minutes: 300, resets_at: resetsAtSec },
              secondary: { used_percent: 56, window_minutes: 10080, resets_at: resetsAtSec + 3600 },
              rate_limit_reached_type: null,
            },
          },
        }),
      );

      phase('armed');
      const job = await waitForResumeJob(server, sid, (j) => j.state === 'armed', 20_000);
      assert(
        job,
        `no resume job was armed from the rollout: ${JSON.stringify(await server.history(sid))}`,
      );
      assert(
        job.trigger.resetAt === resetsAtSec * 1000 && job.nextAt === resetsAtSec * 1000 + MARGIN_MS,
        `armed for the wrong time: ${JSON.stringify({ trigger: job.trigger, nextAt: job.nextAt, resetsAtSec })}`,
      );
      const { episodes } = await server.history(sid);
      assert(
        episodes.length === 1 && episodes[0].source === 'codex-rollout',
        `the episode did not come from the rollout: ${JSON.stringify(episodes)}`,
      );
      assert(fake.submits().length === 0, 'something was written to the PTY before the reset');
      log('armed for resets_at + margin from the rollout file ✓');
    } finally {
      server.close();
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
