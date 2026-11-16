import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VERSION } from './auto-resume-helpers.mjs';
import { c2Auth } from './c2-auth.mjs';
import { C2 } from './c2-peer.mjs';
import { fakeAgentProfile, until } from './conduit-mcp-helpers.mjs';
import { assert, phase, pollUntil, REPO, runScenario } from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';
import { linkView, networkState, startServer } from './net-helpers.mjs';

// The agent setup dialog over one ssh link, on fake-ssh: the app (A) adds server B over C2 and
// opens Set up agents from B's row. Switching to Light drops the checklist and reads Light on the
// row; switching back to Full brings it back. Install opens a visible local pane whose ssh command
// ends with the Claude Code installer. Optional screenshots: CONDUIT_E2E_SHOTS=<dir>.

const WAIT_MS = 15_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];
const SHOTS = process.env.CONDUIT_E2E_SHOTS;
// The reserved agent id a command session carries (src/session-command.ts COMMAND_AGENT_ID).
const PANE_AGENT_ID = 'conduit:command';

/** The app's own server over C2: the same connect as net-machines-ui.e2e.mjs. */
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

/** Numbered screenshots when CONDUIT_E2E_SHOTS names a directory; nothing otherwise. */
async function shot(page, n, name, locator) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const target = locator ?? page;
  await target.screenshot({ path: join(SHOTS, `${n}-${name}.png`) });
}

/** B's mode as the host lists it (`link.list` machines[]): 'full', 'light' or null. */
async function machineMode(appC2, bId) {
  const state = await networkState({ c2: appC2 });
  return state.machines.find((m) => m.machine_id === bId)?.mode ?? null;
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

      phase('1. A adds B over ssh; the row menu opens Set up agents, Full is checked');
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
      const bName = aState.machines.find((m) => m.machine_id === bId)?.machine;
      assert(typeof bName === 'string', `no machine name for ${bId} in link.list`);

      const machineRow = page.locator(`.machines .machine-row[data-machine-id="${bId}"]`);
      await machineRow.waitFor({ state: 'visible', timeout: 10_000 });
      await machineRow.locator('.machine-row-status', { hasText: /^Connected$/ }).waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      // The fake ssh reports the probed CLIs, so the mode starts at the host's full default.
      assert(
        (await machineMode(appC2, bId)) === 'full',
        `B's mode after add: ${await machineMode(appC2, bId)}`,
      );

      await page.locator(`button[aria-label="${bName} actions"]`).click();
      await page.locator('.ctxmenu__item', { hasText: /^Set up agents$/ }).click();
      const dialog = page.locator('.agent-setup[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      const mode = dialog.getByRole('radiogroup', { name: 'Mode' });
      await mode.getByRole('radio', { name: 'Full' }).waitFor({ state: 'visible' });
      assert(
        (await mode.getByRole('radio', { name: 'Full' }).getAttribute('aria-checked')) === 'true',
        'the Full radio is not checked when the dialog opens',
      );
      await dialog.locator('.agent-setup__list').waitFor({ state: 'visible', timeout: 5_000 });
      await shot(page, '1', 'setup-full', dialog);
      log(`setup dialog for "${bName}" opened in Full ✓`);

      phase('2. Light: the host reads mode light, the row says Light, the checklist is gone');
      await mode.getByRole('radio', { name: 'Light' }).click();
      assert(
        await pollUntil(async () => (await machineMode(appC2, bId)) === 'light', 10_000, 250),
        `B's mode never became light within 10 s: ${await machineMode(appC2, bId)}`,
      );
      await machineRow.filter({ hasText: 'Light' }).waitFor({ state: 'visible', timeout: 10_000 });
      assert(
        await pollUntil(
          async () => (await dialog.locator('.agent-setup__list').count()) === 0,
          5_000,
          150,
        ),
        'the agent checklist is still shown in Light mode',
      );
      await shot(page, '2', 'setup-light', dialog);
      log('mode light in link.list, row reads Light, checklist gone ✓');

      phase('3. Full again: the host reads mode full and the checklist returns');
      await mode.getByRole('radio', { name: 'Full' }).click();
      assert(
        await pollUntil(async () => (await machineMode(appC2, bId)) === 'full', 10_000, 250),
        `B's mode never returned to full within 10 s: ${await machineMode(appC2, bId)}`,
      );
      await dialog.locator('.agent-setup__list').waitFor({ state: 'visible', timeout: 5_000 });
      log('mode full in link.list, checklist back ✓');

      phase('4. Install Claude Code opens a local pane; its ssh command ends with the installer');
      const install = dialog.getByRole('button', { name: 'Install Claude Code' });
      await install.waitFor({ state: 'visible', timeout: 5_000 });
      const sessionsBefore = (await appC2.call('events.subscribe', {})).sessions ?? [];
      const knownIds = new Set(sessionsBefore.map((s) => s.id));
      await install.click();
      await dialog.waitFor({ state: 'detached', timeout: WAIT_MS });

      let pane = null;
      assert(
        await pollUntil(
          async () => {
            const snap = await appC2.call('events.subscribe', {});
            pane =
              (snap.sessions ?? []).find(
                (s) => !knownIds.has(s.id) && s.agentId === PANE_AGENT_ID,
              ) ?? null;
            return pane !== null;
          },
          WAIT_MS,
          200,
        ),
        'no new local command session appeared after Install',
      );
      const args = pane.command?.args ?? [];
      assert(args.includes('-t'), `the setup pane has no -t: ${JSON.stringify(pane.command)}`);
      const remoteCommand = args.at(-1) ?? '';
      // The table picks the installer by B's OS, and fake-ssh's "remote" is the runner itself
      // (Windows on CI, Linux locally), so the expected installer follows what B reported.
      const bOs = (await appC2.call('link.list', {})).machines.find(
        (m) => m.machine_id === bId,
      )?.os;
      const installer = bOs === 'windows' ? 'claude.ai/install.ps1' : 'claude.ai/install.sh';
      assert(
        typeof remoteCommand === 'string' && remoteCommand.includes(installer),
        `the setup pane's command does not end with the installer: ${JSON.stringify(pane.command)}`,
      );
      const paneItem = page.locator(`[role="treeitem"][data-sessionid="${pane.id}"]`);
      await paneItem.waitFor({ state: 'visible', timeout: WAIT_MS });
      await shot(page, '4', 'install-pane', page.locator('aside.sidebar'));
      log(`setup pane ${pane.id} selected; ssh args end with the installer ✓`);
      await appC2.call('sessions.remove', { sessionId: pane.id });
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

// An empty HOME for the stand-in's remote shell: this machine's own CLIs live in ~/.local/bin, and
// the probe reads that dir, so without it Install would not be offered for Claude Code.
const remoteHome = mkdtempSync(join(tmpdir(), 'net-agent-setup-home-'));

await runScenario('net-agent-setup', ({ page, userDataDir, log }) => run(page, userDataDir, log), {
  userDataDir: fakeAgentProfile('net-agent-setup'),
  env: {
    ...process.env,
    CONDUIT_SSH_PATH: process.execPath,
    CONDUIT_E2E_SSH_ARGS_PREFIX: JSON.stringify([FAKE_SSH]),
    FAKE_SSH_HOME: remoteHome,
  },
});
