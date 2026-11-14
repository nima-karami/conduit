/**
 * auto-resume-user-hooks-and-statusline — spec 2026-11-13-scheduler-auto-resume §7, "User's own
 * Claude hooks and status line keep working" (R11, spike S1: hooks merge, a statusLine in
 * --settings replaces). The user's settings file in an isolated CLAUDE_CONFIG_DIR has a
 * SessionStart hook and a statusLine command. The fake Claude emulates Claude's merge of that file
 * with the `--settings` Conduit passes, and runs both:
 *   - the user's SessionStart hook runs (it marks a file, and the fake's log has it as source
 *     `user`) beside Conduit's hooks;
 *   - the status line the fake runs is Conduit's wrapper (the `--settings` one), and the line that
 *     reaches the PTY is the user's own, fed the same stdin (it echoes the model and the reset);
 *   - Conduit still sees rate_limits through that wrapper: a limit with a reset arms a job.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  autoResumeProfile,
  connectServer,
  paneHas,
  waitForResumeJob,
  workFolder,
} from './auto-resume-helpers.mjs';
import { assert, openSession, phase, pollUntil, runScenario } from './harness.mjs';

const profile = autoResumeProfile('auto-resume-user-settings');
const { fake } = profile;

// The user's own commands, as small node scripts, so one spelling works in sh and Git Bash.
const scripts = join(profile.userDataDir, 'user-scripts');
mkdirSync(scripts, { recursive: true });
const marker = join(scripts, 'user-hook.log');
const hookScript = join(scripts, 'user-hook.mjs');
const statusScript = join(scripts, 'user-status.mjs');
writeFileSync(
  hookScript,
  `import { appendFileSync } from 'node:fs';
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const p = JSON.parse(s || '{}');
  appendFileSync(process.argv[2], \`\${p.hook_event_name} cwd=\${p.cwd}\\n\`);
});
`,
);
writeFileSync(
  statusScript,
  `let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const p = JSON.parse(s || '{}');
  process.stdout.write(\`USER-STATUS-LINE-OK model=\${p.model?.display_name} five=\${p.rate_limits?.five_hour?.resets_at ?? 'none'}\\n\`);
});
`,
);
const quote = (p) => `'${p}'`;
writeFileSync(
  join(profile.configDir, 'settings.json'),
  JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `${quote(process.execPath)} ${quote(hookScript)} ${quote(marker)}`,
            },
          ],
        },
      ],
    },
    statusLine: { type: 'command', command: `${quote(process.execPath)} ${quote(statusScript)}` },
  }),
);

await runScenario(
  'auto-resume-user-hooks-and-statusline',
  async ({ page, log }) => {
    const server = await connectServer(profile.userDataDir);
    try {
      phase('session');
      const sid = await openSession(page, { path: workFolder(), agentId: profile.agentId });
      const start = await fake.ready();
      assert(
        start.argv.includes('--settings') &&
          start.hookEvents.includes('SessionStart') &&
          start.hookEvents.includes('StopFailure'),
        `the hooks did not merge (user SessionStart + Conduit's): ${JSON.stringify(start)}`,
      );
      assert(
        start.statusLine === 'settings-flag',
        `Conduit's wrapper is not the status line the CLI runs: ${start.statusLine}`,
      );

      phase('the user hook');
      const ran = fake
        .records('HOOK')
        .find((h) => h.event === 'SessionStart' && h.source === 'user');
      assert(
        ran && ran.code === 0,
        `the user's SessionStart hook did not run: ${JSON.stringify(fake.records('HOOK'))}`,
      );
      assert(
        existsSync(marker) && /^SessionStart cwd=/m.test(readFileSync(marker, 'utf8')),
        'the user hook ran but left no mark',
      );

      phase('the user status line');
      const status = fake.records('STATUS')[0];
      assert(
        /^USER-STATUS-LINE-OK model=Opus 5\.5 five=none$/.test(status.out),
        `the status line shown is not the user's: ${JSON.stringify(status)}`,
      );
      assert(
        await paneHas(page, sid, 'USER-STATUS-LINE-OK', 15_000),
        "the user's status line output never reached the pane",
      );

      phase('Conduit still gets rate_limits');
      await fake.cue({ cue: 'limit', resetsInS: 600 });
      const { resetsAtMs } = fake.records('LIMIT').at(-1);
      const shown = fake.records('STATUS').at(-1);
      assert(
        shown.out === `USER-STATUS-LINE-OK model=Opus 5.5 five=${resetsAtMs / 1000}`,
        `the user's status line was not fed the same stdin: ${JSON.stringify(shown)}`,
      );
      const armed = await waitForResumeJob(server, sid, (j) => j.state === 'armed', 15_000);
      assert(
        armed && armed.trigger.resetAt === resetsAtMs,
        'the wrapper did not forward the reset to Conduit',
      );
      assert(
        await pollUntil(
          () =>
            fake
              .records('HOOK')
              .some((h) => h.event === 'StopFailure' && h.source === 'conduit' && h.code === 0),
          5_000,
        ),
        'the StopFailure hook did not run cleanly',
      );
      log("the user's hook and status line work, and Conduit's signals still arrive ✓");
    } finally {
      server.close();
    }
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
