import { execFileSync } from 'node:child_process';
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
import { assignProfileCas } from './permissions-policy-helpers.mjs';

// The remote Files tab over one ssh link, on fake-ssh: B's session folder holds a.txt, .env,
// .ssh/id_rsa and sub/b.txt. A's Files tree for the remote session lists a.txt and sub, not the
// denied .env or .ssh; a click opens a remote tab with B's text, and a change on B shows up in
// that tab. Over A's C2, B refuses the denied and out-of-folder reads. Then editing (CON-44): a
// typed edit saved with Mod+S lands on B; a save after B moved on is refused with a conflict
// banner and a diff, and "Save mine anyway" or B's version resolves it; B refuses denied writes;
// a lead's routed attach_folder adds a B folder to the session. Optional screenshots:
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
  const r = await assignProfileCas(appC2, { kind: 'session', sessionId }, 'lead');
  assert(r.reply?.result?.ok === true, `assign lead: ${JSON.stringify(r)}`);
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
      // A repo, so the Changes, diff and history phases (CON-45) have B's git state to show.
      const git = (...args) =>
        execFileSync(
          'git',
          ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args],
          {
            cwd: bWork,
          },
        );
      git('init', '-q');
      git('add', '.');
      git('commit', '-qm', 'first on B');

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
      // B runs this build, which saves files, so the tab takes edits (CON-44).
      assert(
        tab.readOnly === false,
        `the remote tab's editor is read-only: ${JSON.stringify(tab)}`,
      );
      await shot('2', 'remote-tab', page.locator('.viewer__monaco').first());
      log(`remote tab ${tab.uri} reads "hello from B" and is editable ✓`);

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

      phase('7. a typed edit saved with Mod+S lands on B');
      const editor = page.locator('.viewer__monaco').first();
      const typeAtEnd = async (text) => {
        await editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(text);
      };
      const bText = () => readFileSync(join(bWork, 'a.txt'), 'utf8');
      await typeAtEnd(' +A1');
      await page.keyboard.press('Control+s');
      assert(
        await pollUntil(async () => bText() === 'changed on B +A1', WAIT_MS, 200),
        `the save never landed on B: ${JSON.stringify(bText())}`,
      );
      log('typed edit saved to B ✓');

      phase('8. B moves on under a dirty tab: the save is refused, the diff shows, mine wins');
      await typeAtEnd(' +A2');
      writeFileSync(join(bWork, 'a.txt'), 'B moved on');
      // Saved at once: B's file already differs from what the tab loaded, so B refuses it whether
      // or not the watch's re-read has landed (a dirty buffer is never refreshed: unit-tested in
      // remote-file-saves.test.ts).
      await page.keyboard.press('Control+s');
      const banner = page.locator('.viewer__banner--warn', { hasText: `changed on ${bName}` });
      await banner.waitFor({ state: 'visible', timeout: WAIT_MS });
      assert(bText() === 'B moved on', `B's file changed despite the conflict: ${bText()}`);
      const held = await remoteTab(page);
      assert(
        held?.text === 'changed on B +A1 +A2',
        `the conflicted tab lost the edit: ${JSON.stringify(held)}`,
      );
      await banner.getByRole('button', { name: 'Show diff' }).click();
      await page.locator('.remote-conflict__diff').waitFor({ state: 'visible', timeout: WAIT_MS });
      await shot('3', 'remote-conflict', page.locator('.viewer').first());
      await banner.getByRole('button', { name: 'Save mine anyway' }).click();
      assert(
        await pollUntil(async () => bText() === 'changed on B +A1 +A2', WAIT_MS, 200),
        `"Save mine anyway" never landed: ${JSON.stringify(bText())}`,
      );
      await banner.waitFor({ state: 'hidden', timeout: WAIT_MS });
      log('conflict refused, diff shown, re-apply landed ✓');

      phase("9. B moves on again: taking B's version replaces the edit");
      await typeAtEnd(' +A3');
      writeFileSync(join(bWork, 'a.txt'), 'B wins');
      await page.keyboard.press('Control+s');
      await banner.waitFor({ state: 'visible', timeout: WAIT_MS });
      await banner.getByRole('button', { name: `Use ${bName}’s version` }).click();
      assert(
        await pollUntil(async () => (await remoteTab(page))?.text === 'B wins', WAIT_MS, 200),
        `the tab never took B's version: ${JSON.stringify(await remoteTab(page))}`,
      );
      assert(bText() === 'B wins', `taking B's version wrote to B: ${bText()}`);
      log("B's version taken, nothing written ✓");

      phase('10. B refuses denied and out-of-folder writes');
      const writes = [
        ['the .env in the session folder', join(bWork, '.env')],
        ['a file outside the session', join(b.userData, 'planted.txt')],
      ];
      for (const [what, path] of writes) {
        const message = await rejectionOf(
          appC2.call('remote.fs.write', {
            machineId: bId,
            sessionId: remoteId,
            path,
            data: 'x',
            expect: null,
          }),
        );
        assert(
          message?.includes(REFUSED),
          `remote.fs.write of ${what} did not refuse: ${message ?? 'it resolved'}`,
        );
        log(`remote.fs.write ${what} refused ✓`);
      }
      assert(readFileSync(join(bWork, '.env'), 'utf8') === 'SECRET=1', '.env changed');
      assert(!existsSync(join(b.userData, 'planted.txt')), 'a file was planted outside');

      phase("11. a lead's routed attach_folder adds a B folder to the session");
      const extra = join(b.userData, 'extra');
      mkdirSync(extra);
      writeFileSync(join(extra, 'c.txt'), 'attached');
      const before = await rejectionOf(
        appC2.call('remote.fs.list', { machineId: bId, sessionId: remoteId, path: extra }),
      );
      assert(before?.includes(REFUSED), `the folder was served before attach: ${before}`);
      const attached = await callAppTool(page, lead.sessionId, 'attach_folder', {
        path: extra,
        // open_session already answers with the address form, handle@machine.
        session: opened.handle,
      });
      assert(attached !== null && !attached.error, `attach_folder: ${JSON.stringify(attached)}`);
      assert(
        await pollUntil(
          async () => {
            try {
              const r = await appC2.call('remote.fs.list', {
                machineId: bId,
                sessionId: remoteId,
                path: extra,
              });
              return r.entries.some((e) => e.name === 'c.txt');
            } catch {
              return false;
            }
          },
          WAIT_MS,
          250,
        ),
        'the attached folder never became readable in the session',
      );
      log('attach_folder added the B folder ✓');

      phase("12. Changes lists B's modified file, never a denied one; a click opens B's diff");
      await showRightView(page, 'changes');
      const changes = page.getByRole('list', { name: `Changes on ${bName}` });
      await changes.waitFor({ state: 'visible', timeout: WAIT_MS });
      const changePaths = () => changes.locator('.remote-changes__path').allTextContents();
      assert(
        await pollUntil(async () => (await changePaths()).includes('a.txt'), WAIT_MS, 250),
        `remote Changes never listed a.txt: ${JSON.stringify(await changePaths())}`,
      );
      assert(
        !(await changePaths()).some((p) => p.includes('.env') || p.includes('.ssh')),
        `remote Changes shows a denied path: ${JSON.stringify(await changePaths())}`,
      );
      await changes.locator('.remote-changes__row', { hasText: 'a.txt' }).click();
      const diffSides = () =>
        page.evaluate(() => (window.monaco?.editor.getModels() ?? []).map((m) => m.getValue()));
      assert(
        await pollUntil(
          async () => {
            const sides = await diffSides();
            return sides.includes('hello from B') && sides.includes('B wins');
          },
          WAIT_MS,
          250,
        ),
        "the remote diff never showed HEAD's text against B's file",
      );
      await shot('4', 'remote-changes', page.locator('#right-pane'));
      log('remote Changes lists a.txt, its diff shows HEAD vs B ✓');

      phase("13. History lists B's commit, and the commit's files");
      await changes.getByRole('button', { name: 'History' }).first().click();
      const commit = page.locator('.remote-history__commit', { hasText: 'first on B' });
      await commit.waitFor({ state: 'visible', timeout: WAIT_MS });
      await commit.click();
      await page
        .locator('.remote-history__file-row', { hasText: 'a.txt' })
        .waitFor({ state: 'visible', timeout: WAIT_MS });
      await shot('5', 'remote-history', page.locator('.remote-history__detail').first());
      log("history shows B's commit and its files ✓");

      phase('14. a new file on B shows up in Changes on its own');
      writeFileSync(join(bWork, 'fresh.txt'), 'new on B');
      assert(
        await pollUntil(async () => (await changePaths()).includes('fresh.txt'), 15_000, 500),
        `remote Changes never picked up fresh.txt: ${JSON.stringify(await changePaths())}`,
      );
      log('remote Changes refreshed with fresh.txt ✓');

      phase(
        "15. B narrows A's agents to Worker; a routed open_session asks; Allow in A's pop-up lets it run",
      );
      const aId = (await networkState({ c2: appC2 })).machineId;
      const peer = await assignProfileCas(b.c2, { kind: 'peer', machineId: aId }, 'worker');
      assert(peer.reply?.result?.ok === true, `B's peer assignment: ${JSON.stringify(peer)}`);
      // The tool call waits for B's answer, which waits for the owner here: started, not awaited.
      const routed = callAppTool(page, lead.sessionId, 'open_session', {
        machine: bId,
        agent: ECHO_AGENT,
        path: bWork,
        focus: false,
      });
      // The ask lands in Needs you under B's name; picking it opens the pop-up, as a person does.
      await showRightView(page, 'needs');
      const askRow = page.locator('.needs-list [role="option"]', { hasText: bName });
      await askRow.first().waitFor({ state: 'visible', timeout: WAIT_MS });
      await askRow.first().click();
      const popup = page.locator('.reqtpl-popup');
      await popup.waitFor({ state: 'visible', timeout: WAIT_MS });
      await shot('6', 'remote-permission', popup);
      const allow = popup.getByRole('button', { name: 'Allow', exact: true });
      // The template ignores presses briefly after a request appears (its swap guard).
      assert(
        await pollUntil(async () => await allow.isEnabled(), 5_000, 100),
        'Allow stayed disabled',
      );
      await allow.click();
      const allowedCall = await routed;
      assert(
        typeof allowedCall?.session_id === 'string',
        `open_session after Allow: ${JSON.stringify(allowedCall)}`,
      );
      log("B's permission ask answered from A's pop-up ✓");
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
