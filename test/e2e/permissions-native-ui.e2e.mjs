import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSessionPermissionsDialog, tapMcp, until } from './conduit-mcp-helpers.mjs';
import { assert, closeApp, finishScenario, launchApp, makeLog } from './harness.mjs';
import { startServer } from './net-helpers.mjs';

const log = makeLog('permissions-native-ui');
const threadId = '01a1d190-1af2-7db3-ae44-cb9dacc349ed';
const line = (value) => `${JSON.stringify(value)}\n`;

async function run() {
  const codexHome = mkdtempSync(join(tmpdir(), 'conduit-native-ui-'));
  const previousHome = process.env.CODEX_HOME;
  let server;
  let launched;
  try {
    process.env.CODEX_HOME = codexHome;
    server = await startServer('native-ui', { electronProfile: true });
    const script = join(server.work, 'probe.cjs');
    const command = join(server.work, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    const marker = join(server.work, 'started');
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.stdin.resume();`,
    );
    if (process.platform === 'win32') {
      writeFileSync(command, `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
      writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, {
        mode: 0o700,
      });
    }
    const created = await server.c2.call('sessions.create', {
      agentId: 'conduit:command',
      home: server.work,
      command: { command, args: [] },
      brief: { kind: 'none' },
      placement: { focus: false },
    });
    const sessionId = created.sessionId;
    await server.c2.call('ui.presence', {
      windows: [
        {
          windowId: 1,
          focused: true,
          ready: true,
          visibleSessionIds: [sessionId],
          ownedSessionIds: [sessionId],
        },
      ],
    });
    const policy = (await server.c2.call('events.subscribe')).mcp.policy;
    const point = { kind: 'session', sessionId };
    const assignment = {
      profileId: 'lead',
      applyNative: true,
      exceptions: [],
      onScreenOnly: false,
    };
    const owner = async (message) =>
      (
        await server.c2.call('mcp.fromRenderer', {
          windowId: 1,
          message: { requestId: 1, ...message },
        })
      ).reply?.result;
    const review = await owner({
      type: 'mcp:reviewLocalPolicy',
      expectedToken: policy.editToken,
      edit: { kind: 'assignment', point, assignment },
    });
    assert(review?.ok && review.requiresNativeReview, 'native assignment did not require review');
    const saved = await owner({
      type: 'mcp:saveAssignment',
      point,
      expectedToken: policy.editToken,
      assignment,
      nativeReview: review.digest,
    });
    assert(saved?.ok, 'reviewed native assignment did not save');
    const now = new Date();
    const two = (value) => String(value).padStart(2, '0');
    const folder = join(
      codexHome,
      'sessions',
      String(now.getFullYear()),
      two(now.getMonth() + 1),
      two(now.getDate()),
    );
    mkdirSync(folder, { recursive: true });
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
    const file = join(folder, `rollout-${stamp}-${threadId}.jsonl`);
    const started = await server.c2.call('sessions.start', { sessionId });
    assert(started.ok && started.spawned, 'owned Codex probe did not start');
    assert(await until(() => existsSync(marker), 30_000), 'Codex probe did not execute');
    const createdAt = new Date().toISOString();
    writeFileSync(
      file,
      line({
        timestamp: createdAt,
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: createdAt,
          cwd: server.work,
          originator: 'codex_cli_rs',
          cli_version: '0.145.0',
          source: 'cli',
        },
      }),
    );

    const serverLog = join(server.userData, 'server.log');
    assert(
      await until(() => {
        if (!existsSync(serverLog)) return false;
        return readFileSync(serverLog, 'utf8')
          .split('\n')
          .some((row) => row.includes('codex rollout bound') && row.includes(sessionId));
      }, 30_000),
      'the owned Codex rollout never bound to the watcher',
    );
    await server.c2.call('ui.presence', { windows: [] });

    launched = await launchApp({ userDataDir: server.userData, openFolder: false });
    const { page } = launched;
    await tapMcp(page);
    const row = page.locator(`.session[data-sessionid="${sessionId}"]`);
    await row.waitFor({ timeout: 30_000 });
    await row.locator('.session__select').click();
    const dialog = await openSessionPermissionsDialog(page, sessionId);
    assert((await dialog.getAttribute('aria-modal')) === 'true', 'Permissions was not modal');
    const launchEvidence = dialog.locator('p').filter({ hasText: /^At launch:/ });
    await launchEvidence.waitFor();
    const requested = await launchEvidence.innerText();
    assert(
      requested.includes('Requested workspace-write · on-request'),
      `actual launch request was not shown: ${requested}`,
    );
    await dialog.getByText('Codex thread unavailable; reported mode unknown.').waitFor();
    await dialog.getByLabel('Codex thread UUID from /status').fill(threadId);
    const link = dialog.getByRole('button', { name: 'Link thread' });
    assert(
      await until(
        async () => {
          const linked = dialog.getByText('Linked Codex thread', { exact: true });
          if (await linked.isVisible()) return true;
          if (await link.isEnabled()) await link.click();
          return linked.isVisible();
        },
        30_000,
        500,
      ),
      'the rendered dialog did not link the owned rollout',
    );
    appendFileSync(
      file,
      line({
        timestamp: new Date().toISOString(),
        type: 'turn_context',
        payload: { sandbox_policy: { type: 'workspace-write' }, approval_policy: 'on-request' },
      }),
    );
    const reported = dialog.locator('p').filter({ hasText: /^reported by the Codex thread:/ });
    assert(
      await until(
        async () => (await reported.innerText()).includes('workspace-write · on-request'),
        30_000,
      ),
      'linked rollout reading did not reach the dialog',
    );
    assert(
      !(await dialog.innerText()).includes(threadId),
      'raw thread UUID remained visible after linking',
    );
    if (process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR) {
      mkdirSync(process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({
        path: join(process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR, 'native-linked.png'),
      });
    }
    log('verified actual at-launch request and linked rollout reading in the owner modal');
  } finally {
    if (launched) await closeApp(launched.app, launched.page);
    if (server) await server.stop();
    rmSync(codexHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

let code = 0;
try {
  await run();
  log('PASS ✓');
} catch (error) {
  code = error?.name === 'AssertionError' ? 1 : 2;
  log('FAIL ✗', error?.stack || error?.message || String(error));
}
await finishScenario(code);
