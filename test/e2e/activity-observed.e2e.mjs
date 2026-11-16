/**
 * activity-observed — CON-24 Slice 4 (plan docs/plans/2026-11-14-policy-permissions-machinery.plan.md,
 * "e2e" under Slice 4). Observed rows come from what another CLI did, not from a Conduit tool call:
 *   1. a Conduit-launched fake Codex appends a CommandExecution and a FileChange item to its rollout.
 *      Their output and file contents are FIXTURE-SECRET-* text. Two observed rows must appear: one
 *      carrying the command's first line, one carrying the changed path.
 *   2. a fake Claude's PostToolUse reaches the host through the real hook command Conduit wrote into
 *      the session's --settings file, with the endpoint and token from the launched process's env.
 *      Its tool_response carries FIXTURE-SECRET-* text. One observed row must name Claude Code.
 * In both, no file under the activity directory may hold any FIXTURE-SECRET-* text.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { autoResumeProfile, FAKE_HOOKS, workFolder } from './auto-resume-helpers.mjs';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, openSession, phase, REPO, runScenario } from './harness.mjs';

const SECRET = /FIXTURE-SECRET-/;
const CLAUDE_AGENT_ID = 'e2e-activity-observed-claude';
const CLAUDE_DISPLAY = 'Claude Code';
const CODEX_DISPLAY = 'Codex';
const THREAD_ID = '01a1d190-2af4-7db3-ae44-cb9dacc349ee';
const COMMAND = 'echo ok';

const two = (n) => String(n).padStart(2, '0');
const jsonl = (o) => `${JSON.stringify(o)}\n`;

// The codex profile supplies the isolated home, CODEX_HOME and the `codex` launcher. A second
// launcher named `claude` runs the same fake; both write into the one records directory.
const profile = autoResumeProfile('activity-observed', { as: 'codex' });
const recordsDir = join(profile.userDataDir, 'fake-records');
const ACTIVITY_DIR = join(profile.userDataDir, 'conduit-mcp', 'activity');

function writeClaudeLauncher() {
  const binDir = join(profile.userDataDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const args = `--dir "${recordsDir}" --label claude --as claude --paste on`;
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'claude.cmd'),
      `@"${process.execPath}" "${FAKE_HOOKS}" ${args} %*\r\n`,
    );
    return join(binDir, 'claude.cmd');
  }
  const file = join(binDir, 'claude');
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HOOKS}" ${args} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

const agentsFile = join(profile.userDataDir, 'agents.json');
const agents = JSON.parse(readFileSync(agentsFile, 'utf8'));
agents.push({
  id: CLAUDE_AGENT_ID,
  label: 'Fake claude',
  command: writeClaudeLauncher(),
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});
writeFileSync(agentsFile, JSON.stringify(agents));

/** Complete lines of a fake's records file, in order; a line still being written does not count. */
function fakeRecords(label, kind) {
  const file = join(recordsDir, `${label}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

/** Every Activity row written so far, from the day files under the activity directory. */
function activityRows() {
  if (!existsSync(ACTIVITY_DIR)) return [];
  return readdirSync(ACTIVITY_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .flatMap((name) => {
      const lines = readFileSync(join(ACTIVITY_DIR, name), 'utf8').split('\n');
      lines.pop();
      return lines.map((l) => JSON.parse(l));
    });
}

const observedFor = (sessionId) =>
  activityRows().filter((r) => r.lane === 'observed' && r.principal?.sessionId === sessionId);

/** Every file under the activity directory, read whole, as name -> text. */
function activityFiles() {
  const out = new Map();
  if (!existsSync(ACTIVITY_DIR)) return out;
  for (const name of readdirSync(ACTIVITY_DIR, { recursive: true })) {
    const file = join(ACTIVITY_DIR, name);
    if (statSync(file).isFile()) out.set(name, readFileSync(file, 'utf8'));
  }
  return out;
}

function assertNoSecret(where) {
  for (const [name, text] of activityFiles()) {
    assert(!SECRET.test(text), `${where}: activity file ${name} holds FIXTURE-SECRET text`);
  }
}

/** The rollout item shapes from test/fixtures/codex-rollout/actions.jsonl, with secret output. */
function codexItems(work, filePath) {
  const at = new Date().toISOString();
  return [
    {
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: THREAD_ID,
        turn_id: 'turn-obs-1',
        item: {
          type: 'CommandExecution',
          id: 'exec-obs-1',
          process_id: '1000',
          command: ['/bin/bash', '-lc', COMMAND],
          cwd: work,
          parsed_cmd: [{ type: 'unknown', cmd: COMMAND }],
          source: 'unified_exec_startup',
          status: 'completed',
          aggregated_output: 'FIXTURE-SECRET-codex-output\n',
          exit_code: 0,
          duration: { secs: 0, nanos: 27563 },
        },
        started_at_ms: Date.now(),
        completed_at_ms: Date.now(),
      },
    },
    {
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: THREAD_ID,
        turn_id: 'turn-obs-1',
        item: {
          type: 'FileChange',
          id: 'exec-obs-2',
          changes: { [filePath]: { type: 'add', content: 'FIXTURE-SECRET-codex-content' } },
          status: 'completed',
          stdout: 'FIXTURE-SECRET-codex-stdout',
          stderr: '',
        },
        started_at_ms: Date.now(),
        completed_at_ms: Date.now(),
      },
    },
  ];
}

/**
 * The endpoint and token Conduit put in the launched fake's env. The fake does not log its env and
 * the settings file and MCP config do not carry them, so the running process is read from /proc:
 * its argv names this profile's records directory and FAKE_HOOKS, and its cwd is the launch's cwd.
 */
function launchedEnvOf(start) {
  if (!existsSync('/proc/self/environ')) throw new Error('reading the launched env needs /proc');
  const pids = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let argv;
    let cwd;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // The process exited between listing and reading; it is not the launched fake.
      continue;
    }
    const dirAt = argv.indexOf('--dir');
    if (
      argv.includes(FAKE_HOOKS) &&
      dirAt >= 0 &&
      argv[dirAt + 1] === recordsDir &&
      cwd === start.cwd
    )
      pids.push(pid);
  }
  assert(
    pids.length === 1,
    `expected one launched fake claude in ${start.cwd}, found ${pids.length}: ${pids.join(', ')}`,
  );
  const env = {};
  for (const pair of readFileSync(`/proc/${pids[0]}/environ`, 'utf8').split('\0')) {
    const eq = pair.indexOf('=');
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return {
    CONDUIT_MCP_ENDPOINT: env.CONDUIT_MCP_ENDPOINT,
    CONDUIT_SESSION_TOKEN: env.CONDUIT_SESSION_TOKEN,
  };
}

/** Run the hook command Conduit wrote, with the payload on stdin, as Claude does. */
function runHookCommand(command, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the PostToolUse hook command did not exit within 15 s'));
    }, 15_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

await runScenario(
  'activity-observed',
  async ({ page, log }) => {
    phase('codex rollout: command and file-change rows');
    const work = workFolder();
    const codexSid = await openSession(page, { path: work, agentId: profile.agentId });
    await profile.fake.ready();

    const now = new Date();
    const folder = join(
      profile.codexHome,
      'sessions',
      String(now.getFullYear()),
      two(now.getMonth() + 1),
      two(now.getDate()),
    );
    mkdirSync(folder, { recursive: true });
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
    const rollout = join(folder, `rollout-${stamp}-${THREAD_ID}.jsonl`);
    const filePath = join(work, 'a.txt');
    writeFileSync(
      rollout,
      jsonl({
        timestamp: now.toISOString(),
        type: 'session_meta',
        payload: {
          id: THREAD_ID,
          timestamp: now.toISOString(),
          cwd: work,
          originator: 'codex_cli_rs',
          cli_version: '0.145.0',
          source: 'cli',
        },
      }),
    );

    // The rollout watch binds the file after its session_meta and treats the first read as replay,
    // which emits no actions. Items appended before the bind are lost, and nothing observable
    // says when the bind has happened, so the items are appended until the rows arrive. An
    // attempt that lands in the replay is dropped by the watch, so the next one counts.
    const codexRows = () => observedFor(codexSid);
    const hasCodexRows = () =>
      codexRows().some((r) => r.action === 'command') &&
      codexRows().some((r) => r.action === 'file-change' && r.target === filePath);
    let landed = false;
    for (let attempt = 1; attempt <= 3 && !landed; attempt += 1) {
      appendFileSync(rollout, codexItems(work, filePath).map(jsonl).join(''));
      landed = await until(hasCodexRows, 10_000);
    }
    assert(
      landed,
      `no command and file-change observed rows for ${codexSid} after 3 appends: ${JSON.stringify(codexRows())}`,
    );

    const codexCommand = codexRows().find((r) => r.action === 'command');
    assert(
      codexCommand.lane === 'observed' &&
        codexCommand.cli === 'codex' &&
        codexCommand.decidedBy === `observed: decided by ${CODEX_DISPLAY}, not Conduit`,
      `codex command row: ${JSON.stringify(codexCommand)}`,
    );
    assert(
      codexCommand.summary?.includes(COMMAND),
      `codex command row summary is not the command's first line: ${JSON.stringify(codexCommand)}`,
    );
    assertNoSecret('after the codex rows');
    log('codex command and file-change rows written, no FIXTURE-SECRET text in activity ✓');

    phase('claude PostToolUse through the real hook command');
    const claudeWork = workFolder();
    const claudeSid = await openSession(page, { path: claudeWork, agentId: CLAUDE_AGENT_ID });
    assert(
      await until(() => fakeRecords('claude', 'START').length > 0, 45_000),
      `the fake claude never started for ${claudeSid}`,
    );
    const start = fakeRecords('claude', 'START')[0];
    const argvOf = (flag) => {
      const at = start.argv.indexOf(flag);
      assert(at >= 0 && start.argv[at + 1], `the launch has no ${flag}: ${start.argv.join(' ')}`);
      return start.argv[at + 1];
    };
    // What Claude itself reads: the hook settings and the MCP config Conduit wrote for this launch.
    const settings = JSON.parse(readFileSync(argvOf('--settings'), 'utf8'));
    const hookGroup = settings.hooks?.PostToolUse?.[0];
    const hookCommand = hookGroup?.hooks?.[0]?.command;
    assert(
      typeof hookCommand === 'string' && hookCommand.includes('hook PostToolUse'),
      `no PostToolUse hook command in the launch settings: ${JSON.stringify(settings.hooks)}`,
    );
    // The hook client reads its endpoint and token from its own env, which Claude inherits from
    // the launch (host.ts spawn env). Neither the settings file nor the MCP config carries them.
    const hookEnv = launchedEnvOf(start);
    assert(
      typeof hookEnv.CONDUIT_MCP_ENDPOINT === 'string' &&
        typeof hookEnv.CONDUIT_SESSION_TOKEN === 'string',
      `the launched claude has no endpoint or token in its env: ${JSON.stringify(Object.keys(hookEnv))}`,
    );

    const fixture = JSON.parse(
      readFileSync(
        join(REPO, 'test', 'fixtures', 'claude-hooks', 'post-tool-use-bash.json'),
        'utf8',
      ),
    );
    const payload = {
      ...fixture,
      cwd: claudeWork,
      tool_use_id: 'toolu_activity_observed',
      tool_input: { command: COMMAND, description: 'Run echo ok' },
      tool_response: {
        ...fixture.tool_response,
        stdout: 'FIXTURE-SECRET-claude-stdout',
      },
    };
    const exit = await runHookCommand(hookCommand, payload, hookEnv);
    assert(exit === 0, `the PostToolUse hook command exited ${exit}`);

    const claudeRows = () => observedFor(claudeSid);
    assert(
      await until(() => claudeRows().length >= 1, 10_000),
      `no observed row for the Claude PostToolUse in ${claudeSid}: ${JSON.stringify(activityRows())}`,
    );
    const claudeRow = claudeRows()[0];
    assert(
      claudeRows().length === 1,
      `expected one observed row for one PostToolUse, got ${claudeRows().length}: ${JSON.stringify(claudeRows())}`,
    );
    assert(
      claudeRow.cli === 'claude' &&
        claudeRow.decidedBy === `observed: decided by ${CLAUDE_DISPLAY}, not Conduit`,
      `claude observed row: ${JSON.stringify(claudeRow)}`,
    );
    assert(
      claudeRow.summary?.includes(COMMAND),
      `claude row summary is not the command: ${JSON.stringify(claudeRow)}`,
    );
    assertNoSecret('after the claude PostToolUse');
    log('claude PostToolUse row names Claude Code, no FIXTURE-SECRET text in activity ✓');
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
