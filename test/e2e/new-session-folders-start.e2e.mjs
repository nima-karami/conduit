/**
 * New session dialog, starting a session (mf-new-session spec §7): detected CLI pills, folders
 * through the one `folder:pick` seam (`__pickDirHook`), the host-computed "Launches as" preview,
 * Make home, and the agents.json alias across a relaunch. Also the retired
 * new-session-browse-pinned.e2e.mjs's first half: with a long recents list, Browse… is reachable
 * without scrolling. The rest of the dialog is in new-session-folders-launchers, -guard and -card.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, phase, tapBridge } from './harness.mjs';
import {
  browseAdd,
  clearFolders,
  closeDialog,
  createProject,
  folderNames,
  launchTapped,
  openDialog,
  pick,
  pills,
  runNewSession,
  stateAgents,
  waitPreview,
  waitStubArgs,
} from './new-session-folders-helpers.mjs';

await runNewSession('new-session-folders-start', async ({ fx, log, launch, close }) => {
  const { A, B, stubDir, userDataDir } = fx;
  const { app, page } = await launchTapped(launch);

  phase('multi-folder session');
  const created = await createProject(page);
  log('project created:', created);

  await openDialog(page);
  assert(
    JSON.stringify(await pills(page)) === JSON.stringify(['claude', 'codex', 'Shell']),
    `with only the claude/codex stubs on PATH the row is claude, codex, Shell (got ${await pills(page)})`,
  );
  log('row: claude, codex, Shell ✓ (AC1)');

  await page.locator('.ns-folders__add').click();
  await page.waitForSelector('.ns-addmenu', { state: 'visible' });
  const menu = await page.evaluate(() => {
    const browse = document.querySelector('.ns-addmenu__browse')?.getBoundingClientRect();
    return {
      recents: document.querySelectorAll('.ns-addmenu__item').length,
      browseBottom: browse?.bottom ?? Number.POSITIVE_INFINITY,
      viewport: window.innerHeight,
    };
  });
  assert(menu.recents === 10, `Recent lists at most 10 folders (got ${menu.recents})`);
  assert(
    menu.browseBottom <= menu.viewport,
    `Browse… must be on screen without scrolling (bottom ${menu.browseBottom}, viewport ${menu.viewport})`,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ns-addmenu', { state: 'detached' });
  assert(await page.isVisible('.modal.ns'), 'Escape closes the menu first, not the dialog');
  log('Add folder menu: 10 recents, Browse… reachable, Esc closes the menu only ✓');

  await clearFolders(page);
  await browseAdd(app, page, [A, B]);
  assert(
    JSON.stringify(await folderNames(page)) ===
      JSON.stringify(['room-message-bus', 'bitbucket-ci-image']),
    `A then B are listed (got ${await folderNames(page)})`,
  );
  await page.waitForFunction(
    () => document.querySelector('.ns-folder--home .ns-folder__branch')?.textContent === ' · main',
    null,
    { timeout: 10000 },
  );
  const attached = page.locator('.ns-folder').nth(1);
  assert(
    (await attached.locator('.ns-folder__make').innerText()) === 'Make home' &&
      (await attached.locator('.ns-folder__remove').count()) === 1 &&
      (await page.locator('.ns-folder--home .ns-folder__home').innerText()) === 'Home',
    'A is the Home row (with · main); B is attached with Make home and ×',
  );
  log('folders: A Home · main, B attached ✓');

  await pick(page, 'claude');
  await waitPreview(page, `${A}> claude --add-dir ${B}`);
  log('Launches as ✓ (AC4)');

  await page.locator('.ns-chip--none').click();
  await page.locator('.ns-projects [role="menuitemradio"]', { hasText: 'RMB pipeline' }).click();
  assert(
    (await page.locator('.ns-chip__body').getAttribute('aria-label')) === 'Project: RMB pipeline',
    'the chip names the picked project',
  );

  await page.locator('.ns__foot .btn--primary').click();
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10000 });
  const s1 = await page.evaluate(
    () => window.__results.find((m) => m.type === 'openRepo:result')?.sessionId,
  );
  assert(s1, 'openRepo:result carries the new sessionId');
  const s1State = await page
    .waitForFunction((id) => window.__sessions.find((s) => s.id === id) ?? null, s1)
    .then((h) => h.jsonValue());
  assert(
    s1State.home === A &&
      JSON.stringify(s1State.roots) === JSON.stringify([B]) &&
      s1State.projectId === created &&
      s1State.agentId === 'cli:claude',
    `the session has home A, roots [B], the project and cli:claude (got ${JSON.stringify(s1State)})`,
  );
  log('session: home A, roots [B], RMB pipeline, cli:claude ✓ (AC5)');
  const args = await waitStubArgs(page, s1, 'first');
  assert(
    args.startsWith(`STUB-ARGS:--add-dir ${B}`) && args.split('--add-dir').length === 2,
    `the spawned stub got exactly one --add-dir B (got ${JSON.stringify(args.slice(0, 200))})`,
  );
  log('terminal: STUB-ARGS:--add-dir B ✓ (AC4 spawn half)');

  phase('make home');
  await openDialog(page);
  assert(
    JSON.stringify(await folderNames(page)) ===
      JSON.stringify(['room-message-bus', 'bitbucket-ci-image']),
    "opening again in the project seeds its last session's folders",
  );
  await page.locator('button[aria-label="Make bitbucket-ci-image home"]').click();
  assert(
    (await page.locator('.ns-folder--home .ns-folder__name').innerText()) === 'bitbucket-ci-image',
    'B is home after Make home',
  );
  await page.waitForFunction(
    (b) =>
      document.querySelector('.ns-preview:not(.ns-preview--busy) .ns-preview__cwd')?.textContent ===
      `${b}>`,
    B,
    { timeout: 10000 },
  );
  log('Make home: B is home, preview cwd follows ✓ (AC6)');
  await closeDialog(page);
  await close();

  phase('agents.json alias relaunch');
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify([
      {
        id: 'my-claude',
        label: 'my-claude',
        command: 'claude',
        args: [],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
    ]),
  );
  const second = await launch('second');
  await tapBridge(second.page);
  const agents = await stateAgents(second.page);
  assert(
    agents.includes('my-claude') && !agents.includes('cli:claude'),
    `agents.json's my-claude hides cli:claude (got ${agents})`,
  );
  const restored = await second.page
    .waitForFunction((id) => window.__sessions.find((s) => s.id === id) ?? null, s1, {
      timeout: 30000,
    })
    .then((h) => h.jsonValue());
  assert(
    restored.agentId === 'cli:claude',
    `the persisted session keeps cli:claude (got ${restored.agentId})`,
  );
  await openDialog(second.page);
  const aliasRow = await pills(second.page);
  assert(
    aliasRow.includes('my-claude') && !aliasRow.includes('claude'),
    `the row shows my-claude instead of claude (got ${aliasRow})`,
  );
  await pick(second.page, 'my-claude');
  const wantTitle = join(stubDir, 'claude.cmd');
  await second.page
    .waitForFunction(
      (want) =>
        document.querySelector('.ns-preview:not(.ns-preview--busy)')?.getAttribute('title') ===
        want,
      wantTitle,
      { timeout: 10000 },
    )
    .catch(() => {});
  const resolvedTitle = await second.page.locator('.ns-preview').getAttribute('title');
  assert(
    resolvedTitle === wantTitle,
    `my-claude's preview names the command term:start will spawn (got ${JSON.stringify(resolvedTitle)})`,
  );
  await closeDialog(second.page);
  await second.page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), s1);
  await second.page.locator(`.session[data-sessionid="${s1}"]`).click();
  const aliasArgs = await waitStubArgs(second.page, s1, 'second');
  assert(
    aliasArgs.startsWith(`STUB-ARGS:--add-dir ${B}`),
    `the cli:claude session launches my-claude's claude with its root (got ${JSON.stringify(aliasArgs.slice(0, 200))})`,
  );
  log('alias: my-claude shown, persisted cli:claude session launches it ✓ (AC9)');
});
