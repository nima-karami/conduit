/**
 * conduit-mcp-install — Install from Settings → MCP, then a CLI typed in a plain shell joins
 * messaging through that entry (spec docs/specs/2026-10-27-conduit-mcp-install.md AC2–AC4, AC7;
 * plan T5.2). Every config file lives in an isolated home inside the profile.
 *   1. The Claude Code row reads Not installed; Install writes exactly the §3.4 entry, keeps
 *      `other`, and backs the file up.
 *   2. `claude` typed in a cmd shell runs the fake (claude.cmd on PATH), which reads that entry and
 *      connects as claude-code: the shell gets handle claude-1 and the card's plug.
 *   3. A human message reaches it as a typed notice; the fake reads it with read_inbox.
 *   4. Amendment A1: a claude-code client started by a line that isn't `claude` (as `code .` would)
 *      is pull-only — its message queues and nothing is typed; a prompt typed into the bound CLI
 *      keeps it bound; Ctrl+Z unbinds it.
 *   5. Uninstall removes only conduit; the file and the backup stay.
 * Single gate (spec 2026-10-31-conduit-mcp-single-gate): Install adds mcp__conduit to the user
 * settings.json permissions.allow beside the user's own rule; Uninstall removes only it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  cliRecords,
  conduitCommand,
  FAKE_CLI,
  fakeClaudeOnPath,
  installRow,
  isolatedHome,
  keys,
  mcpState,
  normalizePath,
  openMcpSettings,
  pathWith,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, openSession, profileDir, runScenario, typeLine } from './harness.mjs';

// The gate wants the fake's output to settle (busy window + 3 s quiet + a tick) before the text,
// then the echo and the Enter; the slack covers a loaded runner (see conduit-mcp-gate).
const NOTICE_WITHIN_MS = 20_000;
// Long enough that a notice the gate would have let through had time to land.
const PULL_ONLY_WAIT_MS = 12_000;

const userDataDir = profileDir('mcp-install');
const { homeDir, env: homeEnv } = isolatedHome(userDataDir);
const configPath = join(homeDir, '.claude.json');
const settingsPath = join(homeDir, '.claude', 'settings.json');
const USER_SETTINGS = { model: 'x', permissions: { allow: ['Bash(ls:*)'], deny: ['WebFetch'] } };
const allowOf = () => JSON.parse(readFileSync(settingsPath, 'utf8')).permissions?.allow;
const recordsDir = join(userDataDir, 'cli-records');
const binDir = join(userDataDir, 'bin');
// Inside the profile: the shells keep it as their cwd until the app quits.
const work = join(userDataDir, 'work');
mkdirSync(work, { recursive: true });
fakeClaudeOnPath(binDir, recordsDir, 'claude1');

await runScenario(
  'conduit-mcp-install',
  async ({ app, page, log }) => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(USER_SETTINGS));
    const runtimeHome = await app.evaluate(() => process.getBuiltinModule('node:os').homedir());
    assert(
      normalizePath(runtimeHome) === normalizePath(homeDir),
      `Electron homedir ${runtimeHome} should be the isolated ${homeDir}`,
    );
    await tapMcp(page);

    // 1. install
    await openMcpSettings(page);
    const row = installRow(page, 'Claude Code');
    await row.getByText('Not installed', { exact: true }).waitFor({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Install Conduit for Claude Code' }).click();
    await row.getByText('Installed', { exact: true }).waitFor({ timeout: 10_000 });
    const { command, shim } = await conduitCommand(app);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const want = {
      type: 'stdio',
      command,
      args: [shim],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CONDUIT_SESSION_TOKEN: `\${CONDUIT_SESSION_TOKEN:-}`,
        CONDUIT_MCP_ENDPOINT: `\${CONDUIT_MCP_ENDPOINT:-}`,
      },
    };
    assert(
      isDeepStrictEqual(config.mcpServers?.conduit, want),
      `Claude entry: ${JSON.stringify(config.mcpServers?.conduit)}`,
    );
    assert(isDeepStrictEqual(config.mcpServers?.other, { command: 'x' }), 'other kept');
    assert(existsSync(`${configPath}.conduit-backup`), 'first write backs the file up');
    log('Install wrote the exact Claude entry, kept other, backed up ✓');
    assert(
      isDeepStrictEqual(allowOf(), ['Bash(ls:*)', 'mcp__conduit']),
      `settings.json allow after install: ${JSON.stringify(allowOf())}`,
    );
    log('Install added mcp__conduit to the user settings allow list ✓');
    await page.keyboard.press('Escape');
    await page.locator('.modal.settings').waitFor({ state: 'detached', timeout: 5_000 });

    // 2. connect from a plain shell
    const sid = await openSession(page, { path: work });
    await typeLine(page, sid, 'claude');
    const ready = await until(() => cliRecords(recordsDir, 'claude1', 'READY').length > 0, 30_000);
    assert(
      ready,
      `the fake never connected: ${JSON.stringify(cliRecords(recordsDir, 'claude1', 'NO_ENTRY'))}`,
    );
    const connected = await until(async () => {
      const s = (await mcpState(page))?.sessions?.[sid];
      return s?.handle === 'claude-1' && s.connected === true;
    }, 15_000);
    assert(connected, `shell state: ${JSON.stringify((await mcpState(page))?.sessions?.[sid])}`);
    await page
      .locator(`.session[data-sessionid="${sid}"] .session__mcp-link`)
      .and(page.getByRole('img', { name: 'Connected to Conduit as claude-1' }))
      .waitFor({ timeout: 10_000 });
    log('claude typed in cmd → claude-1, connected, card shows the plug ✓');

    // 3. a human message is noticed and read
    const compose = async (handle, body) => {
      await page.locator('.rightpane .rtab', { hasText: 'Messages' }).click();
      await page.locator('.mcpmsg__bar button', { hasText: 'New message' }).click();
      await page.locator('.mcpmsg-compose__recipient', { hasText: handle }).click();
      await page.locator('.mcpmsg-compose__body').click();
      await page.keyboard.type(body);
      await page.locator('.mcpmsg-compose button', { hasText: 'Send' }).click();
    };
    const hasBody = (label, body) =>
      cliRecords(recordsDir, label, 'INBOX').some((r) => r.bodies.some((b) => b.includes(body)));
    await compose('claude-1', 'install check from the human');
    const read = await until(
      () => hasBody('claude1', 'install check from the human'),
      NOTICE_WITHIN_MS,
    );
    assert(read, `no INBOX: ${JSON.stringify(cliRecords(recordsDir, 'claude1', 'INPUT'))}`);
    log('the notice was typed and the fake read the message ✓');

    // 4. amendment A1: unbound clients are pull-only
    const sid2 = await openSession(page, { path: work });
    await typeLine(
      page,
      sid2,
      `"${process.execPath}" "${FAKE_CLI}" --as claude --records "${recordsDir}" --name ide1`,
    );
    const ideReady = await until(() => cliRecords(recordsDir, 'ide1', 'READY').length > 0, 30_000);
    assert(ideReady, 'the unbound claude-code client never connected');
    const ide = await until(async () => {
      const s = (await mcpState(page))?.sessions?.[sid2];
      return s?.connected === true && s.gate === 'pull-only';
    }, 15_000);
    assert(ide, `unbound shell: ${JSON.stringify((await mcpState(page))?.sessions?.[sid2])}`);
    const ideHandle = (await mcpState(page)).sessions[sid2].handle;
    // A prompt typed into the bound CLI keeps the binding.
    await typeLine(page, sid, 'hello');
    await until(
      () => cliRecords(recordsDir, 'claude1', 'INPUT').some((r) => r.line === 'hello'),
      10_000,
    );
    await compose(ideHandle, 'for the ide client');
    await compose('claude-1', 'after a prompt');
    const stillBound = await until(() => hasBody('claude1', 'after a prompt'), NOTICE_WITHIN_MS);
    assert(stillBound, 'a prompt typed into the bound CLI unbound it');
    assert(!hasBody('ide1', 'for the ide client'), 'an unbound claude-code client got a notice');
    const typedIde = cliRecords(recordsDir, 'ide1', 'INPUT').filter((r) =>
      r.line.includes('[conduit]'),
    );
    assert(
      typedIde.length === 0,
      `notice typed into the unbound session: ${JSON.stringify(typedIde)}`,
    );
    assert(
      (await mcpState(page)).sessions[sid2].unread >= 1,
      'the unbound client’s message stays queued',
    );
    // Ctrl+Z hands the prompt back to the shell: the binding ends while the client stays live.
    await keys(page, sid, '\x1a');
    const suspended = await until(async () => {
      const s = (await mcpState(page))?.sessions?.[sid];
      return s?.connected === true && s.gate === 'pull-only';
    }, 10_000);
    assert(suspended, `after Ctrl+Z: ${JSON.stringify((await mcpState(page))?.sessions?.[sid])}`);
    await compose('claude-1', 'after ctrl-z');
    await sleep(PULL_ONLY_WAIT_MS);
    assert(!hasBody('claude1', 'after ctrl-z'), 'a suspended CLI got a notice');
    log(
      `A1: ${ideHandle} (no claude line) stays pull-only; a prompt keeps claude-1 bound; Ctrl+Z unbinds ✓`,
    );

    // 5. uninstall
    await openMcpSettings(page);
    await row.getByRole('button', { name: 'Uninstall Conduit from Claude Code' }).click();
    await row.getByText('Not installed', { exact: true }).waitFor({ timeout: 10_000 });
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert(!Object.hasOwn(after.mcpServers ?? {}, 'conduit'), 'Uninstall removes conduit');
    assert(isDeepStrictEqual(after.mcpServers?.other, { command: 'x' }), 'other kept');
    assert(existsSync(`${configPath}.conduit-backup`), 'the backup stays');
    log('Uninstall removed only conduit; file and backup stay ✓');
    const settingsAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert(
      isDeepStrictEqual(settingsAfter, USER_SETTINGS),
      `settings.json after uninstall: ${JSON.stringify(settingsAfter)}`,
    );
    log('Uninstall removed only mcp__conduit from settings.json ✓');
  },
  { userDataDir, env: { ...homeEnv, ...pathWith(binDir) } },
);
