/**
 * activity-observed — CON-24 Slice 4 (plan docs/plans/2026-11-14-policy-permissions-machinery.plan.md,
 * "e2e" under Slice 4). Observed rows come from what another CLI did, not from a Conduit tool call:
 *   1. a Conduit-launched fake Codex appends a CommandExecution and a FileChange item to its rollout.
 *      The command is two lines, its second line and the output and file contents are FIXTURE-SECRET
 *      text. The command row's summary must be the first line only, and the file-change row must
 *      name the path.
 *   2. a fake Claude fires PostToolUse through the hook command Conduit wrote into the launch's
 *      --settings file (the fake's `post-tool-use` cue, the same path as its other hook events).
 *      The Bash command is two lines with FIXTURE-SECRET text on line 2, and tool_response carries
 *      more. One observed row must name Claude Code.
 * In both, no file under the activity directory may hold any FIXTURE-SECRET-* text. The hook client's
 * allow-list strip is covered by its unit tests; this scenario checks only the host's rows and files.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
// The first line is the summary; the second carries secret text the host must not record.
const COMMAND_TEXT = `${COMMAND}\n# FIXTURE-SECRET-cmd-tail`;

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
          command: ['/bin/bash', '-lc', COMMAND_TEXT],
          cwd: work,
          parsed_cmd: [{ type: 'unknown', cmd: COMMAND_TEXT }],
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
    const isCommandRow = (r) => r.action === 'command' && r.summary === COMMAND;
    const isFileRow = (r) => r.action === 'file-change' && r.target === filePath;
    let landed = false;
    for (let attempt = 1; attempt <= 3 && !landed; attempt += 1) {
      appendFileSync(rollout, codexItems(work, filePath).map(jsonl).join(''));
      landed = await until(
        () => codexRows().some(isCommandRow) && codexRows().some(isFileRow),
        10_000,
      );
    }
    assert(
      landed,
      `no command and file-change observed rows for ${codexSid} after 3 appends: ${JSON.stringify(codexRows())}`,
    );

    // Duplicates from an extra append are fine; every row must be one of the two expected kinds.
    for (const r of codexRows()) {
      assert(
        r.lane === 'observed' &&
          r.cli === 'codex' &&
          r.decidedBy === `observed: decided by ${CODEX_DISPLAY}, not Conduit` &&
          (isCommandRow(r) || isFileRow(r)),
        `unexpected codex observed row: ${JSON.stringify(r)}`,
      );
    }
    assertNoSecret('after the codex rows');
    log('codex command and file-change rows written, no FIXTURE-SECRET text in activity ✓');

    phase('claude PostToolUse through the launch settings hook');
    const claudeWork = workFolder();
    const claudeSid = await openSession(page, { path: claudeWork, agentId: CLAUDE_AGENT_ID });
    assert(
      await until(() => fakeRecords('claude', 'READY').length > 0, 45_000),
      `the fake claude never reported READY for ${claudeSid}`,
    );
    const start = fakeRecords('claude', 'START')[0];
    const settingsAt = start.argv.indexOf('--settings');
    assert(settingsAt >= 0, `the launch has no --settings: ${start.argv.join(' ')}`);
    // The hook command Conduit wrote for this launch; the fake runs it with the launch env.
    const settings = JSON.parse(readFileSync(start.argv[settingsAt + 1], 'utf8'));
    const hookCommand = settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command;
    assert(
      typeof hookCommand === 'string' && hookCommand.includes('hook PostToolUse'),
      `no PostToolUse hook command in the launch settings: ${JSON.stringify(settings.hooks)}`,
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
      tool_input: { command: COMMAND_TEXT, description: 'Run echo ok' },
      tool_response: {
        ...fixture.tool_response,
        stdout: 'FIXTURE-SECRET-claude-stdout',
      },
    };
    const cueId = 'post-tool-use-1';
    appendFileSync(
      join(recordsDir, 'claude.cue'),
      jsonl({ id: cueId, cue: 'post-tool-use', payload }),
    );
    assert(
      await until(() => fakeRecords('claude', 'CUE_DONE').some((r) => r.id === cueId), 30_000),
      `the fake claude never finished the post-tool-use cue ${cueId}`,
    );
    const errors = fakeRecords('claude', 'ERROR');
    assert(errors.length === 0, `the fake claude failed: ${JSON.stringify(errors)}`);
    const hooks = fakeRecords('claude', 'HOOK').filter((r) => r.event === 'PostToolUse');
    assert(
      hooks.length === 1 && hooks[0].source === 'conduit' && hooks[0].code === 0,
      `the PostToolUse hook ran as ${JSON.stringify(hooks)}, expected one conduit hook exiting 0`,
    );

    const claudeRows = () => observedFor(claudeSid);
    assert(
      await until(() => claudeRows().length >= 1, 10_000),
      `no observed row for the Claude PostToolUse in ${claudeSid}: ${JSON.stringify(activityRows())}`,
    );
    assert(
      claudeRows().length === 1,
      `expected one observed row for one PostToolUse, got ${claudeRows().length}: ${JSON.stringify(claudeRows())}`,
    );
    const claudeRow = claudeRows()[0];
    assert(
      claudeRow.cli === 'claude' &&
        claudeRow.decidedBy === `observed: decided by ${CLAUDE_DISPLAY}, not Conduit`,
      `claude observed row: ${JSON.stringify(claudeRow)}`,
    );
    assert(
      claudeRow.action === 'command' &&
        claudeRow.summary === COMMAND &&
        claudeRow.target === claudeWork,
      `claude row is not the command's first line in the launch cwd: ${JSON.stringify(claudeRow)}`,
    );
    assertNoSecret('after the claude PostToolUse');
    log('claude PostToolUse row names Claude Code, no FIXTURE-SECRET text in activity ✓');
  },
  { userDataDir: profile.userDataDir, env: profile.env },
);
