import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { assert, phase, pollUntil, REPO, runScenario, showRightView } from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';
import { ECHO_AGENT, linkView, networkState, startServer } from './net-helpers.mjs';

// The remote Files tab over one ssh link, on fake-ssh: B's session folder holds a.txt, .env,
// .ssh/id_rsa and sub/b.txt. A's Files tree for the remote session lists a.txt and sub, not the
// denied .env or .ssh; a click opens a read-only remote tab with B's text, and a change on B shows
// up in that tab. Over A's C2, B refuses the denied and out-of-folder reads. Optional screenshots:
// CONDUIT_E2E_SHOTS=<dir>.

const WAIT_MS = 15_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];
const SHOTS = process.env.CONDUIT_E2E_SHOTS;
const REFUSED = '"kind":"refused"';

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

/** Gives one agent session the Lead profile through CON-24's assignment message, as the renderer does. */
async function assignLead(appC2, sessionId) {
  const r = await appC2.call('mcp.fromRenderer', {
    windowId: 1,
    message: {
      type: 'mcp:setAssignment',
      requestId: 1,
      point: { kind: 'session', sessionId },
      profileId: 'lead',
    },
  });
  assert(r.reply?.ok === true, `setAssignment lead: ${JSON.stringify(r)}`);
}

/** Numbered screenshots when CONDUIT_E2E_SHOTS names a directory; nothing otherwise. */
async function shot(n, name, locator) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await locator.screenshot({ path: join(SHOTS, `${n}-${name}.png`) });
}

/** The labels of the rows the remote tree shows now, in tree order. */
const treeLabels = (tree) => tree.locator('.remote-files__label').allTextContents();

/** The remote model's text and whether its editor is read-only, or null before the tab exists. */
const remoteTab = (page) =>
  page.evaluate(() => {
    const model = window.monaco?.editor.getModels().find((m) => m.uri.scheme === 'conduit-remote');
    if (!model) return null;
    const editor = (window.monaco.editor.getEditors() ?? []).find((e) => e.getModel() === model);
    return {
      uri: model.uri.toString(),
      text: model.getValue(),
      readOnly: editor ? editor.getOption(window.monaco.editor.EditorOption.readOnly) : null,
    };
  });

/** The error text a C2 call rejects with, or null when it resolved. */
async function rejectionOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

      // The folder the session opens on: a file to show, two to hide, and a folder with a file.
      writeFileSync(join(bWork, 'a.txt'), 'hello from B');
      writeFileSync(join(bWork, '.env'), 'SECRET=1');
      mkdirSync(join(bWork, '.ssh'));
      writeFileSync(join(bWork, '.ssh', 'id_rsa'), 'key');
      mkdirSync(join(bWork, 'sub'));
      writeFileSync(join(bWork, 'sub', 'b.txt'), 'nested');

      phase('1. A adds B over ssh; a Lead agent on A opens a session on B; its remote row shows');
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

      await tapMcp(page);
      const work = mkdtempSync(join(tmpdir(), 'net-remote-files-'));
      const lead = await openFake(page, work);
      await assignLead(appC2, lead.sessionId);
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

      const remoteRow = page
        .getByRole('tree', { name: 'Agents' })
        .locator('.remote-session')
        .filter({ hasText: `on ${bName}` });
      assert(
        await pollUntil(async () => (await remoteRow.count()) > 0, WAIT_MS, 100),
        `no remote row "on ${bName}" after open_session`,
      );
      log(`remote row "on ${bName}" present ✓`);

      phase('2. the Files tab lists a.txt and sub, and hides .env and .ssh');
      await remoteRow.locator('.session__select').click();
      await showRightView(page, 'files');
      const tree = page.getByRole('tree', { name: `Files on ${bName}` });
      await tree.waitFor({ state: 'visible', timeout: WAIT_MS });
      assert(
        await pollUntil(
          async () => {
            const labels = await treeLabels(tree);
            return labels.includes('a.txt') && labels.includes('sub');
          },
          WAIT_MS,
          200,
        ),
        `the remote tree never listed a.txt and sub: ${JSON.stringify(await treeLabels(tree))}`,
      );
      const topLabels = await treeLabels(tree);
      assert(
        !topLabels.includes('.env') && !topLabels.includes('.ssh'),
        `the remote tree shows a denied entry: ${JSON.stringify(topLabels)}`,
      );
      await shot('1', 'remote-files', page.locator('#right-pane'));
      log(`remote tree lists ${JSON.stringify(topLabels)} ✓`);

      phase("3. clicking a.txt opens a read-only remote tab with B's text");
      await tree.locator('.remote-files__label', { hasText: /^a\.txt$/ }).click();
      assert(
        await pollUntil(
          async () => (await remoteTab(page))?.text.includes('hello from B') ?? false,
          WAIT_MS,
          200,
        ),
        `the remote tab never showed "hello from B": ${JSON.stringify(await remoteTab(page))}`,
      );
      const tab = await remoteTab(page);
      assert(
        tab.readOnly === true,
        `the remote tab's editor is not read-only: ${JSON.stringify(tab)}`,
      );
      await shot('2', 'remote-tab', page.locator('.viewer__monaco').first());
      log(`remote tab ${tab.uri} reads "hello from B" and is read-only ✓`);

      phase('4. a change on B reaches the open remote tab');
      writeFileSync(join(bWork, 'a.txt'), 'changed on B');
      assert(
        await pollUntil(
          async () => (await remoteTab(page))?.text.includes('changed on B') ?? false,
          10_000,
          200,
        ),
        `the remote tab did not follow the change on B within 10 s: ${JSON.stringify(await remoteTab(page))}`,
      );
      log('remote tab shows "changed on B" ✓');

      phase('5. A asks B for denied and out-of-folder files; B refuses each');
      const denied = [
        ['the .env in the session folder', join(bWork, '.env')],
        ['/etc/passwd', '/etc/passwd'],
      ];
      for (const [what, path] of denied) {
        const message = await rejectionOf(
          appC2.call('remote.fs.read', { machineId: bId, sessionId: remoteId, path }),
        );
        assert(
          message?.includes(REFUSED),
          `remote.fs.read of ${what} did not refuse: ${message ?? 'it resolved'}`,
        );
        log(`remote.fs.read ${what} refused ✓`);
      }
      const listed = await appC2.call('remote.fs.list', {
        machineId: bId,
        sessionId: remoteId,
        path: bWork,
      });
      const names = listed.entries.map((e) => e.name);
      assert(
        names.includes('a.txt') && names.includes('sub'),
        `remote.fs.list of the folder: ${JSON.stringify(names)}`,
      );
      assert(
        !names.includes('.env') && !names.includes('.ssh'),
        `remote.fs.list of the folder shows a denied entry: ${JSON.stringify(names)}`,
      );
      log(`remote.fs.list of the folder omits .env and .ssh ✓`);

      phase('6. expanding sub lists b.txt');
      await tree.locator('.remote-files__label', { hasText: /^sub$/ }).click();
      assert(
        await pollUntil(async () => (await treeLabels(tree)).includes('b.txt'), WAIT_MS, 200),
        `expanding sub never listed b.txt: ${JSON.stringify(await treeLabels(tree))}`,
      );
      log('sub expanded, b.txt listed ✓');
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

await runScenario('net-remote-files', ({ page, userDataDir, log }) => run(page, userDataDir, log), {
  userDataDir: fakeAgentProfile('net-remote-files'),
  env: {
    ...process.env,
    CONDUIT_SSH_PATH: process.execPath,
    CONDUIT_E2E_SSH_ARGS_PREFIX: JSON.stringify([FAKE_SSH]),
  },
});
