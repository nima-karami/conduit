/**
 * C# navigation through a host-owned csharp-ls (docs/specs/2026-10-08-language-support.md §7,
 * Lane B): B2 untrusted folder runs no csharp-ls/dotnet, B6 the palette's trust prompt names C#
 * and every served toolset, B1 the install hint with csharp-ls unreachable — all three need no
 * server, so they run before the install check — then B3 F12 / hover / breadcrumbs against the
 * real server and no orphans after quit. B4 (idle stop) is csharp-lsp-idle: it cannot share this
 * scenario's 200 s deadline with B3's server load.
 *
 * B3 needs csharp-ls and a .NET 10 SDK: `dotnet tool install --global csharp-ls`.
 * Run: node test/e2e/run-smoke.mjs csharp-lsp   (needs `npm run build` first)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CSHARP_TOOLS,
  csharpLsInstalled,
  GREET_CALL,
  READY_CEILING_MS,
  recordTree,
  restoreFixture,
  survivorsAfter,
  waitCsState,
  waitDefinition,
  writeCsharpFixture,
} from './csharp-fixture.mjs';
import { clearTransients, observe, openDoc, placeCursor, pointOn } from './goto-matrix.mjs';
import { assert, closeApp, launchApp, openSession, runScenario } from './harness.mjs';

const INSTALL_TOAST =
  'C# navigation needs csharp-ls — install with `dotnet tool install --global csharp-ls`';

const endsWith = (p, suffix) => (p ?? '').toLowerCase().endsWith(suffix.toLowerCase());

async function waitFor(page, pred, ms) {
  const deadline = Date.now() + ms;
  let last = await observe(page);
  while (Date.now() < deadline) {
    if (pred(last)) return last;
    await page.waitForTimeout(150);
    last = await observe(page);
  }
  return last;
}

async function runPalette(page, query, title) {
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill(query);
  const row = page.locator('.palette__title', { hasText: title });
  await row.first().waitFor({ state: 'visible', timeout: 5000 });
  await row.first().click();
}

/** B2 + B6. With csharp-ls installed the open is Restricted and raises a prompt unasked; without
 *  it the server is absent and nothing is asked — either way nothing from .NET may run. */
async function untrustedAndPrompt(app, page, sid, program, installed, log) {
  const appPid = await app.evaluate(() => process.pid);
  await openDoc(app, page, sid, program);
  const held = await waitCsState(page, installed ? 'restricted' : 'absent', log);
  assert(held.pid === null, `an untrusted server has a pid: ${JSON.stringify(held)}`);
  await page.waitForTimeout(1_000);
  const spawned = recordTree(appPid).filter((p) => CSHARP_TOOLS.test(p.name));
  assert(spawned.length === 0, `untrusted folder spawned ${JSON.stringify(spawned)}`);
  log(`B2 untrusted folder: ${held.state}, no csharp-ls / dotnet process ✓`);

  const promptBox = page.locator('.trust-prompt');
  if (installed) {
    // Declined so the next prompt is the palette's own, not the one the open raised.
    await promptBox.waitFor({ state: 'visible', timeout: 10_000 });
    await promptBox.getByRole('button', { name: /Don.t Trust/ }).click();
    await promptBox.waitFor({ state: 'detached', timeout: 10_000 });
  }

  await openDoc(app, page, sid, program);
  await runPalette(
    page,
    '>Workspace Trust: Trust Current Folder',
    /^Workspace Trust: Trust Current Folder$/,
  );
  await promptBox.waitFor({ state: 'visible', timeout: 10_000 });
  const why = ((await promptBox.locator('.trust-prompt__why').textContent()) ?? '').trim();
  log(`B6 palette prompt → ${why}`);
  assert(why.startsWith('C# navigation runs tools from this project'), `prompt names: ${why}`);
  assert(
    why.includes('gopls, go list') && why.includes('csharp-ls, dotnet / MSBuild'),
    `prompt does not list every toolset: ${why}`,
  );
  log('B6 palette trust with a .cs active names C# and both toolsets ✓');
  await promptBox.getByRole('button', { name: 'Trust', exact: true }).click();
  await promptBox.waitFor({ state: 'detached', timeout: 10_000 });
}

/** B1: csharp-ls nowhere the host looks — PATH without .dotnet/tools, every home at an empty dir. */
async function missingScenario(dir, program, log) {
  const empty = mkdtempSync(join(tmpdir(), 'conduit-nocsls-'));
  const sys = process.env.SystemRoot ?? 'C:\\Windows';
  const path = `${sys}\\System32;${sys}`;
  const env = {
    PATH: path,
    Path: path,
    USERPROFILE: empty,
    HOME: empty,
    DOTNET_CLI_HOME: empty,
  };
  const third = await launchApp({ env });
  try {
    const { app, page } = third;
    const sid = await openSession(page, { path: dir });
    await openDoc(app, page, sid, program);
    await waitCsState(page, 'absent', log, 20_000);
    // Twice inside one toast lifetime (5 s): the second F12 must not stack another toast.
    await placeCursor(page, program, 'Greet(');
    await page.keyboard.press('F12');
    await waitFor(page, (o) => o.toasts.includes(INSTALL_TOAST), 8_000);
    await page.keyboard.press('F12');
    await page.waitForTimeout(1_000);
    const r = await observe(page);
    const errors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.toast--error .toast__msg, .toast.error')).map(
        (e) => e.textContent,
      ),
    );
    log(`missing csharp-ls → toasts ${JSON.stringify(r.toasts)} errors ${JSON.stringify(errors)}`);
    assert(
      r.toasts.filter((t) => t === INSTALL_TOAST).length === 1,
      `expected exactly one install toast, got ${JSON.stringify(r.toasts)}`,
    );
    assert(r.toasts.length === 1, `unexpected extra toasts: ${JSON.stringify(r.toasts)}`);
    assert(errors.length === 0, `error toasts: ${JSON.stringify(errors)}`);
    await placeCursor(page, program, 'namespace');
    await page.keyboard.type('x');
    const edited = await page.evaluate(() =>
      window.monaco.editor
        .getEditors()
        .some((e) => e.getModel()?.getValue().startsWith('nxamespace')),
    );
    assert(edited, 'Program.cs was not editable with csharp-ls missing');
    await page.keyboard.press('Control+Z');
    log('B1 csharp-ls missing: one install toast, no error, still editable ✓');
  } finally {
    await third.cleanup();
  }
}

async function navigation(app, page, sid, program, log) {
  await waitCsState(page, 'ready', log, READY_CEILING_MS);
  const def = await waitDefinition(
    page,
    program,
    GREET_CALL.line,
    GREET_CALL.character,
    log,
    90_000,
  );
  assert(
    endsWith(def.locations[0]?.path, 'Greeter.cs') && def.locations[0]?.range.start.line === 6,
    `definition → ${JSON.stringify(def.locations)}`,
  );

  await openDoc(app, page, sid, program);
  await clearTransients(page);
  await placeCursor(page, program, 'Greet(');
  await page.keyboard.press('F12');
  const f12 = await waitFor(page, (o) => endsWith(o.path, 'Greeter.cs'), 15_000);
  log(`F12 Greet → ${f12.path}:${f12.line} "${f12.lineText}" toasts=${JSON.stringify(f12.toasts)}`);
  assert(endsWith(f12.path, 'Greeter.cs'), `F12 landed in ${f12.path}`);
  assert(f12.lineText.includes('public string Greet'), `caret line is "${f12.lineText}"`);

  await openDoc(app, page, sid, program);
  const hp = await pointOn(page, program, 'Greet(');
  await page.mouse.move(hp.x - 60, hp.y + 60);
  await page.mouse.move(hp.x, hp.y, { steps: 4 });
  const hoverText = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.monaco-hover')]
          .map((e) => e.textContent ?? '')
          .find((t) => t.includes('Greet(')) ?? null,
      null,
      { timeout: 15_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  log(`hover Greet → ${JSON.stringify(hoverText)}`);
  assert(
    hoverText?.includes('string name'),
    `hover lacks the signature: ${JSON.stringify(hoverText)}`,
  );
  await page.mouse.move(5, 5);

  await placeCursor(page, program, 'new Greeter');
  const crumbs = await page
    .waitForFunction(
      () => {
        const segs = [...document.querySelectorAll('.breadcrumb-bar__seg--symbol')].map(
          (b) => b.lastChild?.textContent ?? '',
        );
        return segs.some((s) => /^Program\b/.test(s)) ? segs : null;
      },
      null,
      { timeout: 15_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  log(`breadcrumb symbols → ${JSON.stringify(crumbs)}`);
  assert(crumbs, 'the breadcrumb bar never showed the class Program');
  log('B3 F12 / hover / breadcrumbs against csharp-ls ✓');
}

runScenario('csharp-lsp', async ({ app, page, log }) => {
  const installed = csharpLsInstalled();
  const dir = mkdtempSync(join(tmpdir(), 'conduit-cs-'));
  const { program } = writeCsharpFixture(dir);
  const sid = await openSession(page, { path: dir });
  await untrustedAndPrompt(app, page, sid, program, installed, log);
  const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  await closeApp(app, page);

  await missingScenario(dir, program, log);

  assert(installed, 'csharp-lsp B3 needs csharp-ls: dotnet tool install --global csharp-ls');
  restoreFixture(dir, log);
  // Same profile: the folder was trusted through the palette prompt above.
  const second = await launchApp({ userDataDir: profile });
  try {
    const sid2 = await openSession(second.page, { path: dir });
    await openDoc(second.app, second.page, sid2, program);
    await navigation(second.app, second.page, sid2, program, log);

    const live = await waitCsState(second.page, 'ready', log);
    const quitTree = recordTree(live.pid);
    log(`csharp-ls tree before quit: ${quitTree.map((p) => `${p.name}:${p.pid}`).join(', ')}`);
    assert(/csharp-ls/i.test(quitTree[0].name), `snapshot pid ${live.pid} is not csharp-ls`);
    await closeApp(second.app, second.page);
    const quitLeft = await survivorsAfter(quitTree, 10_000);
    assert(quitLeft.length === 0, `alive 10 s after quit: ${JSON.stringify(quitLeft)}`);
    log('no csharp-ls orphans after a normal quit ✓');
  } finally {
    await second.cleanup();
  }
});
