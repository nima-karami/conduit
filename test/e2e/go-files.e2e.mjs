/**
 * Go module files and the language-generic nav message (docs/specs/2026-09-22-go-files-basics.md
 * §6): go.mod paints with the `gomod` grammar on open and in a diff, the four module files wear
 * the Go-blue icon in the coloured pack, and F12 outside JS/TS names the file's language.
 *
 * Go itself has a language server now (docs/specs/2026-09-22-language-server-go.md), so this
 * scenario runs with gopls hidden — as go-lsp's missing-gopls case does — and main.go gets that
 * outcome's install message. It must not depend on what the machine has installed.
 *
 * Token colour is read as `mtk*` classes, not pixels. Tokenize-before-open mirrors
 * editor-first-paint: `tokenize` consults the registry synchronously, so it answers "was the
 * grammar registered before the editor existed" with no rAF timing (the window is hidden).
 *
 * Run: node test/e2e/run-smoke.mjs go-files   (needs `npm run build` first)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { clearTransients, observe, openDoc, placeCursor, trigger } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';

const INSTALL_TOAST =
  'Go navigation needs gopls — install with `go install golang.org/x/tools/gopls@latest`';

/**
 * Hide gopls from the app this scenario launches (the harness launch inherits this process's
 * env). GOPATH, GOBIN and the home dir point at an empty dir, as in go-lsp's missing-gopls case;
 * PATH keeps every entry that holds neither gopls nor go, because the app's Changes view still
 * needs git.
 */
function hideGopls() {
  const empty = mkdtempSync(join(tmpdir(), 'conduit-nogopls-'));
  const holdsGo = (dir) =>
    ['gopls', 'gopls.exe', 'go', 'go.exe'].some((b) => existsSync(join(dir, b)));
  process.env.PATH = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((d) => d && !holdsGo(d))
    .join(delimiter);
  process.env.GOPATH = empty;
  process.env.GOBIN = '';
  process.env.HOME = empty;
  process.env.USERPROFILE = empty;
}
hideGopls();

const GO_BLUE = '#00add8';
const MODULE_FILES = ['go.mod', 'go.sum', 'go.work', 'go.work.sum'];
const GO_MOD = `module example.com/hello

go 1.22

require (
\tgolang.org/x/net v0.0.0-20210101000000-abcdef123456 // indirect
\tgithub.com/pkg/errors v0.9.1+incompatible
)

replace example.com/old => ./local
`;

function buildRepo() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-gofiles-'));
  const git = (...a) => execFileSync('git', a, { cwd: root });
  git('init', '-q');
  git('config', 'user.email', 'go@t');
  git('config', 'user.name', 'Go');
  writeFileSync(join(root, 'go.mod'), GO_MOD);
  writeFileSync(join(root, 'go.sum'), 'golang.org/x/net v0.1.0 h1:abc=\n');
  writeFileSync(join(root, 'go.work'), 'go 1.22\n\nuse ./svc\n');
  writeFileSync(join(root, 'go.work.sum'), 'golang.org/x/text v0.3.0 h1:def=\n');
  writeFileSync(join(root, 'main.go'), 'package main\n\nfunc main() { helper() }\n');
  writeFileSync(join(root, 'main.py'), 'def helper():\n    return 1\n\nhelper()\n');
  writeFileSync(join(root, 'notes.txt'), 'helper notes\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  writeFileSync(join(root, 'go.mod'), `${GO_MOD}\nrequire rsc.io/quote v1.5.2\n`);
  return root;
}

const fileRow = (page, name) =>
  page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
  });

const tokenTypes = (page) =>
  page.evaluate(() => [
    ...new Set(
      (window.monaco.editor.tokenize('module example.com/x v1.2.3', 'gomod')[0] ?? []).map(
        (t) => t.type,
      ),
    ),
  ]);

/** mtk class of the rendered span holding `text`, inside `scope`'s view lines. Trimmed because
 *  Monaco merges adjacent same-class tokens, so an uncoloured path shares a span with its
 *  surrounding whitespace. */
const spanClasses = (page, scope, texts) =>
  page.evaluate(
    ({ scope, texts }) => {
      const out = {};
      for (const t of texts) {
        const span = [...document.querySelectorAll(`${scope} .view-line span span`)].find(
          (s) => s.textContent.trim() === t,
        );
        out[t] = span ? [...span.classList].find((c) => c.startsWith('mtk')) : null;
      }
      return out;
    },
    { scope, texts },
  );

async function waitForDistinctClasses(page, scope, texts, log, label) {
  let got = {};
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    got = await spanClasses(page, scope, texts);
    const cls = Object.values(got);
    if (cls.every(Boolean) && new Set(cls).size === texts.length) break;
    await page.waitForTimeout(500);
  }
  log(`${label} classes: ${JSON.stringify(got)}`);
  const cls = Object.values(got);
  assert(
    cls.every(Boolean) && new Set(cls).size === texts.length,
    `${label}: expected ${texts.length} distinct mtk classes, got ${JSON.stringify(got)}`,
  );
}

async function expectToast(app, page, sid, abs, token, want, log) {
  await clearTransients(page);
  await openDoc(app, page, sid, abs);
  await placeCursor(page, abs, token);
  const { after } = await trigger(page, 'f12');
  const all = [...after.toasts, after.overlay].join(' | ');
  log(`F12 in ${abs.split(/[\\/]/).pop()}: ${all}`);
  assert(
    after.toasts.some((t) => t === want),
    `expected toast "${want}", saw ${JSON.stringify(after)}`,
  );
  assert(!/JS\/TS/.test(all), 'the old JS/TS-only copy must be gone');
}

runScenario('go-files', async ({ app, page, log }) => {
  const root = buildRepo();
  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.evaluate(() => {
    window.__settings = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state') window.__settings = m.settings;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  await page.waitForFunction(() => !!window.__settings, null, { timeout: 10000 });
  const cur = await page.evaluate(() => window.__settings);
  await page.evaluate(
    (s) =>
      window.agentDeck.post({
        type: 'updateSettings',
        settings: { ...s, iconPack: 'colored', iconPackPinned: true },
      }),
    cur,
  );
  await page.waitForFunction(() => window.__settings?.iconPack === 'colored', null, {
    timeout: 10000,
  });

  const before = await tokenTypes(page);
  log(`gomod token types before opening go.mod: ${JSON.stringify(before)}`);
  assert(before.length <= 1, `gomod should be untokenized before any open: ${before}`);

  // The diff goes first: once the code editor has registered the grammar, a diff would paint
  // whether or not the diff path registers it itself.

  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Changes'))
      ?.click();
  });
  await page.locator('.change', { hasText: 'go.mod' }).first().click();
  await page.waitForFunction(
    () => (window.monaco.editor.getDiffEditors?.() ?? []).length > 0,
    null,
    { timeout: 15000 },
  );
  await waitForDistinctClasses(
    page,
    '.monaco-diff-editor .editor.modified',
    ['require', 'rsc.io/quote', 'v1.5.2'],
    log,
    'go.mod diff',
  );
  await page.screenshot({
    path: join(process.env.GO_FILES_SHOTS ?? tmpdir(), 'go-files-diff.png'),
  });

  await page.locator('.rtab', { hasText: 'Files' }).click();
  for (const name of MODULE_FILES) {
    const icon = fileRow(page, name).first().locator('.filerow__icon').first();
    await icon.waitFor({ state: 'attached', timeout: 20000 });
    const stroke = (await icon.getAttribute('stroke'))?.toLowerCase();
    log(`${name} explorer icon stroke=${stroke}`);
    assert(stroke === GO_BLUE, `${name} icon should be ${GO_BLUE}, got ${stroke}`);
  }
  const goStroke = await fileRow(page, 'main.go')
    .first()
    .locator('.filerow__icon')
    .first()
    .getAttribute('stroke');
  log(`main.go icon stroke=${goStroke} (reference)`);

  await fileRow(page, 'go.mod').first().click();
  await page.waitForFunction(
    () =>
      window.monaco?.editor
        .getEditors()
        .some(
          (e) =>
            e.getModel()?.uri.path.endsWith('/go.mod') && e.getModel().getLanguageId() === 'gomod',
        ),
    null,
    { timeout: 30000 },
  );
  const after = await tokenTypes(page);
  log(`gomod token types after opening go.mod: ${JSON.stringify(after)}`);
  for (const t of ['keyword.gomod', 'identifier.gomod', 'number.gomod']) {
    assert(after.includes(t), `grammar missing ${t} on open: ${JSON.stringify(after)}`);
  }
  await waitForDistinctClasses(
    page,
    '.monaco-editor:not(.monaco-diff-editor *)',
    ['module', 'example.com/hello', 'v0.9.1+incompatible'],
    log,
    'go.mod editor',
  );
  await page.screenshot({
    path: join(process.env.GO_FILES_SHOTS ?? tmpdir(), 'go-files-editor.png'),
  });

  await expectToast(app, page, sid, join(root, 'main.go'), 'helper', INSTALL_TOAST, log);
  await expectToast(
    app,
    page,
    sid,
    join(root, 'main.py'),
    'helper',
    'Code navigation isn’t available for Python files.',
    log,
  );
  await expectToast(
    app,
    page,
    sid,
    join(root, 'notes.txt'),
    'helper',
    'Code navigation isn’t available for this file type.',
    log,
  );
  log('final view:', JSON.stringify((await observe(page)).toasts));
});
