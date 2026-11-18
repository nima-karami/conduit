import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VERSION } from './auto-resume-helpers.mjs';
import { c2Auth } from './c2-auth.mjs';
import { C2 } from './c2-peer.mjs';
import {
  callTool as callAppTool,
  fakeAgentProfile,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, logicalLines, phase, pollUntil, REPO, runScenario } from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';
import { ECHO_AGENT, linkView, networkState, readAudit, startServer } from './net-helpers.mjs';
import { assignLocalSessionProfile } from './permissions-policy-helpers.mjs';

// The Machines UI over one ssh link, on fake-ssh: the app (A) adds server B over C2, shows B's
// machine row as Connected, and an agent on A with Lead opens a session on B. That session is drawn
// under the lead as a remote row; clicking it attaches a remote pane that types into B. Disconnect
// from the row's menu leaves B's session running. Optional screenshots: CONDUIT_E2E_SHOTS=<dir>.

const WAIT_MS = 15_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];
const SHOTS = process.env.CONDUIT_E2E_SHOTS;

/** The app's own server over C2: the same connect as asks-no-window.e2e.mjs. */
async function serverClient(userDataDir) {
  const { serverEndpoint } = teardownNames(userDataDir, process.platform, tmpdir());
  let c2 = null;
  const ok = await pollUntil(
    async () => {
      try {
        c2 = await C2.open(serverEndpoint);
        await c2.call('hello', {
          appVersion: APP_VERSION,
          generation: SERVER_PROTOCOL_GENERATION,
          auth: c2Auth(userDataDir),
        });
        return true;
      } catch {
        c2?.close();
        c2 = null;
        return false;
      }
    },
    30_000,
    250,
  );
  assert(ok && c2, 'the app server pipe never accepted a hello');
  return c2;
}

/** A read_screen result as plain text: the echo's own `ECHO:` prefixes and padding removed. */
function screenText(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows
    .map((r) => (typeof r === 'string' ? r : (r?.text ?? '')))
    .join('')
    .replace(/ECHO:/g, '')
    .replace(/\s+/g, '');
}

/** Numbered screenshots when CONDUIT_E2E_SHOTS names a directory; nothing otherwise. */
async function shot(page, n, name, locator) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const target = locator ?? page;
  await target.screenshot({ path: join(SHOTS, `${n}-${name}.png`) });
}

async function run(page, userDataDir, log) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let b;
  try {
    // B's server and the ssh stand-in both read these from this process.
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([FAKE_SSH]);
    const appC2 = await serverClient(userDataDir);
    try {
      b = await startServer('b');
      const bWork = b.work;

      phase('1. A adds B over ssh; the Machines row for B reads Connected');
      const added = await appC2.call('link.sshAdd', {
        ssh: {
          target: 'fake',
          node: process.execPath,
          mainJs: join(REPO, 'out', 'server', 'main.js'),
          userData: b.userData,
        },
      });
      const bId = (await networkState(b)).machineId;
      assert(
        added?.ok === true && added.machineId === bId,
        `link.sshAdd: ${JSON.stringify(added)}`,
      );
      assert(
        await until(async () => {
          const view = await linkView(appC2, bId);
          return view?.state === 'up' && view.transport === 'ssh';
        }, WAIT_MS),
        'A never reached B up over ssh',
      );
      const aState = await networkState({ c2: appC2 });
      const aId = aState.machineId;
      const bName = aState.machines.find((m) => m.machine_id === bId)?.machine;
      assert(typeof bName === 'string', `no machine name for ${bId} in link.list`);

      const machineRow = page.locator(`.machines .machine-row[data-machine-id="${bId}"]`);
      await machineRow.waitFor({ state: 'visible', timeout: 10_000 });
      await machineRow.locator('.machine-row-status', { hasText: /^Connected$/ }).waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      await shot(page, '1', 'machines', page.locator('aside.sidebar'));
      log(`machine row "${bName}" Connected ✓`);

      phase('2. a Lead agent on A opens a session on B; the remote row sits under the lead');
      await tapMcp(page);
      const work = mkdtempSync(join(tmpdir(), 'net-machines-ui-'));
      const lead = await openFake(page, work);
      const assignment = await assignLocalSessionProfile(page, appC2, lead.sessionId, 'lead');
      assert(assignment.ok === true, `assign lead: ${JSON.stringify(assignment)}`);
      const opened = await callAppTool(page, lead.sessionId, 'open_session', {
        machine: bId,
        agent: ECHO_AGENT,
        path: bWork,
        focus: false,
      });
      assert(
        typeof opened?.session_id === 'string' && typeof opened.handle === 'string',
        `open_session on ${bId}: ${JSON.stringify(opened)}`,
      );
      const remoteId = opened.session_id;
      const address = opened.handle;

      // The row is drawn twice: under its lead here, and under its machine in the Machines tree.
      const remoteRow = page
        .getByRole('tree', { name: 'Agents' })
        .locator('.remote-session')
        .filter({ hasText: `on ${bName}` });
      // The 2 s budget (spec S6) runs from open_session returning.
      assert(
        await pollUntil(async () => (await remoteRow.count()) > 0, 2_000, 100),
        `no remote row "on ${bName}" within 2 s of open_session returning`,
      );
      const afterLead = await page.evaluate(
        ({ leadId, name }) => {
          const lead = document.querySelector(`[data-sessionid="${leadId}"]`);
          const tree = document.querySelector('[role="tree"][aria-label="Agents"]');
          const remote = [...(tree?.querySelectorAll('.remote-session') ?? [])].find((e) =>
            (e.textContent ?? '').includes(`on ${name}`),
          );
          return Boolean(
            lead &&
              remote &&
              lead.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        },
        { leadId: lead.sessionId, name: bName },
      );
      assert(afterLead, 'the remote row is not after its lead row in the Agents tree');
      await shot(page, '2', 'remote-row', page.locator('aside.sidebar'));
      log(`remote row "on ${bName}" under the lead ✓`);

      phase('3. clicking the remote row attaches a live remote pane');
      // An ssh controller's drive is granted by its connection, so no capability call is needed.
      // The pane's xterm joins window.__terms (opt-in), read as its buffer: it renders via WebGL.
      await page.evaluate(() => {
        window.__terms = {};
      });
      await remoteRow.locator('.session__select').click();
      const pane = page.locator('.remote-pane');
      await pane.locator('.xterm').waitFor({ state: 'visible', timeout: WAIT_MS });
      const paneKey = `remote:${bId}:${remoteId}`;
      let paneText = [];
      assert(
        await pollUntil(
          async () => {
            paneText = (await logicalLines(page, paneKey)) ?? [];
            return paneText.some((line) => line.includes('E2E-READY'));
          },
          WAIT_MS,
          200,
        ),
        `the remote pane never showed B's ready line; buffer: ${JSON.stringify(paneText).slice(-300)}`,
      );
      await shot(page, '3', 'remote-pane', pane);
      log('remote pane painted ✓');

      phase('4. typing in the pane reaches B; B audits drive.start for A');
      await pane.locator('.xterm').click();
      const marker = `m${Date.now().toString(36)}`;
      await page.keyboard.type(marker);
      await page.keyboard.press('Enter');
      let lastScreen = '';
      assert(
        await pollUntil(
          async () => {
            const screen = await callAppTool(page, lead.sessionId, 'read_screen', {
              session: address,
            });
            lastScreen = screenText(screen);
            return lastScreen.includes(marker);
          },
          WAIT_MS,
          500,
        ),
        `B's session never showed the marker ${marker}; last screen: ${lastScreen.slice(-300)}`,
      );
      assert(
        await pollUntil(
          () => readAudit(b.userData).some((e) => e.kind === 'drive.start' && e.peer === aId),
          WAIT_MS,
          200,
        ),
        `B has no drive.start audit for peer ${aId}`,
      );
      log(`marker ${marker} on B's screen ✓, drive.start for A ✓`);

      phase('4b. the Add machine dialog opens from the Machines header and closes on Escape');
      await page.locator('.panel-head__actions button[aria-label="Add machine"]').click();
      const dialog = page.locator('[role="dialog"]');
      await dialog.first().waitFor({ state: 'visible', timeout: 5_000 });
      await shot(page, '4b', 'add-dialog', dialog.first());
      await page.keyboard.press('Escape');
      await dialog.first().waitFor({ state: 'detached', timeout: 5_000 });
      log('add dialog opened and closed ✓');

      phase('5. Disconnect from the row menu; B keeps its session running');
      await page.locator(`button[aria-label="${bName} actions"]`).click();
      await page.locator('.ctxmenu__item', { hasText: /^Disconnect$/ }).click();
      await machineRow
        .locator('.machine-row-status', { hasText: /^Disconnected$/ })
        .waitFor({ state: 'visible', timeout: 10_000 });
      await shot(page, '5', 'disconnected', page.locator('aside.sidebar'));
      const bSnap = await b.c2.call('events.subscribe', {});
      const stillRunning = bSnap.sessions?.find((s) => s.id === remoteId);
      assert(
        stillRunning?.runtime?.spawn === 'live',
        `B's session after disconnect: ${JSON.stringify(stillRunning?.runtime)}`,
      );
      log('row reads Disconnected ✓, B session still live ✓');
    } finally {
      appC2.close();
    }
  } catch (error) {
    if (b) {
      const file = join(b.userData, 'server.log');
      if (existsSync(file)) log('b server.log tail:\n', readFileSync(file, 'utf8').slice(-8000));
    }
    throw error;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await b?.stop();
  }
}

await runScenario('net-machines-ui', ({ page, userDataDir, log }) => run(page, userDataDir, log), {
  userDataDir: fakeAgentProfile('net-machines-ui'),
  env: {
    ...process.env,
    CONDUIT_SSH_PATH: process.execPath,
    CONDUIT_E2E_SSH_ARGS_PREFIX: JSON.stringify([FAKE_SSH]),
  },
});
