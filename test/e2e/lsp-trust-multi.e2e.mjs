/**
 * Workspace Trust across three installed servers (docs/specs/archive/2026-10-08-language-coverage.md §7):
 * B2 an untrusted folder with `.py` + `.rs` + `.cpp` open starts no server process and raises ONE
 * prompt listing every server's tools, one line each; B9 with an extensionless Python script
 * active, the palette's "Trust Current Folder" names Python.
 *
 * Needs basedpyright, rust-analyzer and clangd — an absent server is never a trust question, so
 * without them there is no prompt to check. Fails, never skips, when one is missing.
 * Run: node test/e2e/run-smoke.mjs lsp-trust-multi   (needs `npm run build` first)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clangdProbe, writeClangdFixture } from './clangd-fixture.mjs';
import { openDoc } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import { assertInstalled, lsp, probeServer, recordTree, waitServerState } from './lsp-fixture.mjs';
import { writePythonFixture } from './python-fixture.mjs';
import { writeRustFixture } from './rust-fixture.mjs';

const SERVER_PROCS = /basedpyright|pyright|node\.exe|python|rust-analyzer|cargo|rustc|clangd/i;
/** src/lsp-registry.ts LANGUAGE_SERVERS' runsTools, in registry order. */
const TOOL_LINES = [
  'gopls, go list',
  'csharp-ls, dotnet / MSBuild (evaluates project files)',
  "basedpyright, python (reads the interpreter's import paths)",
  'rust-analyzer, cargo metadata, build scripts and proc-macros',
  'clangd (reads compile_commands.json; writes .cache/clangd)',
];

async function runPalette(page, query, title) {
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill(query);
  const row = page.locator('.palette__title', { hasText: title });
  await row.first().waitFor({ state: 'visible', timeout: 5000 });
  await row.first().click();
}

runScenario('lsp-trust-multi', async ({ app, page, log }) => {
  assertInstalled(
    [
      ['basedpyright-langserver', probeServer('where', ['basedpyright-langserver'])],
      ['rust-analyzer', probeServer('rust-analyzer', ['--version'])],
      ['clangd', clangdProbe()],
    ],
    'lsp-trust-multi e2e needs basedpyright, rust-analyzer and clangd installed',
  );
  const dir = mkdtempSync(join(tmpdir(), 'conduit-trust-multi-'));
  const py = writePythonFixture(join(dir, 'py'));
  const rs = writeRustFixture(join(dir, 'rs'));
  const cpp = writeClangdFixture(join(dir, 'cpp'));
  const sid = await openSession(page, { path: dir });
  const appPid = await app.evaluate(() => process.pid);

  // ── B2 ──
  const promptIds = new Set();
  for (const [file, languageId] of [
    [py.main, 'python'],
    [rs.main, 'rust'],
    [cpp.main, 'cpp'],
  ]) {
    await openDoc(app, page, sid, file);
    const held = await waitServerState(page, languageId, 'restricted', log, 30_000);
    assert(held.pid === null, `an untrusted server has a pid: ${JSON.stringify(held)}`);
    const { prompt } = await lsp(page, { type: 'lsp:trustState' });
    if (prompt) promptIds.add(prompt.id);
  }
  await page.evaluate(() => {
    window.__trustPoll = { pending: false, value: null, error: null };
  });
  let changed = null;
  try {
    const handle = await page.waitForFunction(
      () => {
        const state = window.__trustPoll;
        if (state.error) throw new Error(state.error);
        const changed = state.value?.servers.find(
          (s) => ['python', 'rust', 'cpp'].includes(s.languageId) && s.state !== 'restricted',
        );
        if (changed) return changed;
        if (!state.pending) {
          state.pending = true;
          window.agentDeck.lsp({ type: 'lsp:statusSnapshot' }).then(
            (value) => {
              state.value = value;
              state.pending = false;
            },
            (error) => {
              state.error = String(error);
            },
          );
        }
        return false;
      },
      null,
      { timeout: 2_000 },
    );
    changed = await handle.jsonValue();
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
  }
  assert(!changed, `an untrusted server left the restricted state: ${JSON.stringify(changed)}`);
  const spawned = recordTree(appPid).filter((p) => SERVER_PROCS.test(p.name));
  assert(spawned.length === 0, `untrusted folder spawned ${JSON.stringify(spawned)}`);
  assert(promptIds.size === 1, `expected one prompt for the folder, saw ${[...promptIds]}`);

  const promptBox = page.locator('.trust-prompt');
  await promptBox.waitFor({ state: 'visible', timeout: 10_000 });
  const lines = await promptBox.locator('.trust-prompt__tool').allTextContents();
  log(`B2 prompt tool lines → ${JSON.stringify(lines)}`);
  assert(
    JSON.stringify(lines) === JSON.stringify(TOOL_LINES),
    `prompt lists ${JSON.stringify(lines)}`,
  );
  log('B2 untrusted .py + .rs + .cpp: no server process, one prompt, one line per server ✓');

  // ── B9 ── declined first, so the next prompt is the palette's own
  await promptBox.getByRole('button', { name: /Don.t Trust/ }).click();
  await promptBox.waitFor({ state: 'detached', timeout: 10_000 });
  await openDoc(app, page, sid, py.tool);
  await runPalette(
    page,
    '>Workspace Trust: Trust Current Folder',
    /^Workspace Trust: Trust Current Folder$/,
  );
  await promptBox.waitFor({ state: 'visible', timeout: 10_000 });
  const why = ((await promptBox.locator('.trust-prompt__why').textContent()) ?? '').trim();
  log(`B9 palette prompt → ${why}`);
  assert(why.startsWith('Python navigation runs tools from this project'), `prompt names: ${why}`);
  log('B9 extensionless Python script active → the palette prompt names Python ✓');
});
