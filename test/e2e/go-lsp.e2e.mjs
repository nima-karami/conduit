/**
 * Go navigation through a host-owned gopls, end to end against the real binary
 * (docs/specs/2026-09-22-language-server-go.md §7.2).
 *
 * Host level: definition over the bridge, and no gopls (or descendant) outlives the app — after a
 * normal quit AND after only the Electron main process is force-killed. The force-kill case is
 * the one that decides whether a Windows Job object is needed (spec §2.4); it is not a flake to
 * retry past.
 *
 * Editor level, through the app's own gestures: F12, a real Ctrl+click, Shift+F12, an agent
 * rewriting an unopened file, the palette restart, and a machine with no gopls at all.
 *
 * Needs gopls installed: `go install golang.org/x/tools/gopls@latest`.
 * Run: node test/e2e/run-smoke.mjs go-lsp   (needs `npm run build` first)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTransients, observe, openDoc, placeCursor, trigger } from './goto-matrix.mjs';
import { assert, closeApp, launchApp, openSession, runScenario } from './harness.mjs';

const READY_CEILING_MS = 120_000;
const INSTALL_TOAST =
  'Go navigation needs gopls — install with `go install golang.org/x/tools/gopls@latest`';

function writeGoFixture(dir) {
  mkdirSync(join(dir, 'pkg', 'util'), { recursive: true });
  writeFileSync(join(dir, 'go.mod'), 'module example.com/fix\n\ngo 1.22\n');
  writeFileSync(
    join(dir, 'main.go'),
    'package main\n\nimport "example.com/fix/pkg/util"\n\nfunc main() {\n\thelper()\n\t_ = util.Greet()\n}\n',
  );
  writeFileSync(join(dir, 'helper.go'), 'package main\n\nfunc helper() {}\n');
  writeFileSync(
    join(dir, 'pkg', 'util', 'util.go'),
    'package util\n\n// Greet says hi.\nfunc Greet() string { return "hi" }\n',
  );
}

/** The host's own lookup is richer (spec §3.4); this only has to tell "installed" from "not". */
function goplsInstalled() {
  if (spawnSync('where', ['gopls'], { stdio: 'ignore' }).status === 0) return true;
  return existsSync(join(homedir(), 'go', 'bin', 'gopls.exe'));
}

/** `pid` and every descendant, by ParentProcessId walk. */
function recordTree(pid) {
  const json = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const procs = JSON.parse(json);
  const tree = [{ pid, name: procs.find((p) => p.ProcessId === pid)?.Name ?? '?' }];
  for (let i = 0; i < tree.length; i++) {
    for (const p of procs) {
      if (p.ParentProcessId === tree[i].pid) tree.push({ pid: p.ProcessId, name: p.Name });
    }
  }
  return tree;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function survivorsAfter(tree, ms) {
  const deadline = Date.now() + ms;
  let left = tree;
  while (Date.now() < deadline) {
    left = tree.filter((p) => alive(p.pid));
    if (left.length === 0) return [];
    await new Promise((r) => setTimeout(r, 200));
  }
  return left;
}

const lsp = (page, msg) => page.evaluate((m) => window.agentDeck.lsp(m), msg);

async function waitReady(page, log) {
  const t0 = Date.now();
  while (Date.now() - t0 < READY_CEILING_MS) {
    const snap = await lsp(page, { type: 'lsp:statusSnapshot' });
    const ready = snap.servers.find((s) => s.state === 'ready');
    if (ready) {
      log(`gopls ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (pid ${ready.pid})`);
      return ready;
    }
    const bad = snap.servers.find((s) => s.state === 'absent' || s.state === 'crashed');
    assert(!bad, `gopls server went ${bad?.state}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(false, `gopls never reached ready within ${READY_CEILING_MS / 1000}s`);
}

async function openGoDoc(page, path) {
  return lsp(page, {
    type: 'lsp:open',
    path,
    languageId: 'go',
    version: 1,
    text: readFileSync(path, 'utf8'),
  });
}

const endsWith = (p, suffix) => (p ?? '').toLowerCase().endsWith(suffix.toLowerCase());

/** Screen point on `token` in the editor showing `absPath` (for a real mouse click). */
async function pointOn(page, absPath, token) {
  return page.evaluate(
    ({ path, tok }) => {
      const ed = window.monaco.editor
        .getEditors()
        .find((e) => e.getModel()?.uri.path.toLowerCase() === `/${path.toLowerCase()}`);
      const model = ed.getModel();
      const pos = model.getPositionAt(model.getValue().indexOf(tok) + 2);
      ed.revealPosition(pos);
      const vp = ed.getScrolledVisiblePosition(pos);
      const r = ed.getDomNode().getBoundingClientRect();
      return { x: r.left + vp.left + 2, y: r.top + vp.top + vp.height / 2 };
    },
    { path: absPath.replace(/\\/g, '/'), tok: token },
  );
}

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

/** Set the buffer of the editor showing `absPath`; returns the previous text. */
function setBuffer(page, absPath, edit) {
  return page.evaluate(
    ({ path, e }) => {
      const ed = window.monaco.editor
        .getEditors()
        .find((x) => x.getModel()?.uri.path.toLowerCase() === `/${path.toLowerCase()}`);
      const model = ed.getModel();
      const before = model.getValue();
      model.setValue(e.whole ?? before.replace(e.from, e.to));
      return before;
    },
    { path: absPath.replace(/\\/g, '/'), e: edit },
  );
}

async function editorScenarios(app, page, sid, dir, log) {
  const main = join(dir, 'main.go');
  const helper = join(dir, 'helper.go');
  await page.evaluate(() => {
    window.__lspStates = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'lsp:status') window.__lspStates.push(m.status.state);
    });
  });
  await openDoc(app, page, sid, main);
  await waitReady(page, log);

  // ── definition across files in one package (F12) ──
  await placeCursor(page, main, 'helper');
  const f12 = (await trigger(page, 'f12')).after;
  log(
    `F12 helper → ${f12.path}:${f12.line} "${f12.lineText}" toasts=${JSON.stringify(f12.toasts)}`,
  );
  assert(endsWith(f12.path, 'helper.go'), `F12 landed in ${f12.path}`);
  assert(f12.lineText.includes('func helper'), `caret line is "${f12.lineText}"`);

  // ── definition across packages (real Ctrl+click; also proves finding #9) ──
  await openDoc(app, page, sid, main);
  const at = await pointOn(page, main, 'Greet');
  await page.keyboard.down('Control');
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up('Control');
  const click = await waitFor(page, (o) => endsWith(o.path, 'util.go'), 10_000);
  log(`Ctrl+click Greet → ${click.path}:${click.line} "${click.lineText}"`);
  assert(endsWith(click.path, 'util.go'), `Ctrl+click landed in ${click.path}`);
  assert(click.lineText.includes('func Greet'), `caret line is "${click.lineText}"`);

  // ── references (Shift+F12) ──
  await openDoc(app, page, sid, helper);
  await placeCursor(page, helper, 'helper');
  await clearTransients(page);
  await page.keyboard.press('Shift+F12');
  const peek = await waitFor(page, (o) => o.peek, 10_000);
  await page.waitForTimeout(500);
  const refs = await page.evaluate(() => ({
    files: Array.from(document.querySelectorAll('.zone-widget .reference-file')).map((e) =>
      (e.textContent ?? '').trim(),
    ),
    rows: document.querySelectorAll('.zone-widget .monaco-list-row').length,
    title: document.querySelector('.zone-widget .peekview-title')?.textContent?.trim() ?? '',
  }));
  log(`Shift+F12 helper → peek=${peek.peek} ${JSON.stringify(refs)}`);
  assert(peek.peek, 'references did not open the peek widget');
  assert(
    refs.files.length === 2 &&
      refs.files.some((f) => f.includes('helper.go')) &&
      refs.files.some((f) => f.includes('main.go')),
    `references peek should list helper.go and main.go, got ${JSON.stringify(refs.files)}`,
  );
  await clearTransients(page);

  // ── hover (real mouse) ──
  await openDoc(app, page, sid, main);
  const hp = await pointOn(page, main, 'Greet');
  await page.mouse.move(hp.x - 60, hp.y + 60);
  await page.mouse.move(hp.x, hp.y, { steps: 4 });
  const hoverText = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.monaco-hover')]
          .map((e) => e.textContent ?? '')
          .find((t) => t.includes('Greet says hi.')) ?? null,
      null,
      { timeout: 10_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  log(`hover Greet → ${JSON.stringify(hoverText)}`);
  assert(
    hoverText?.includes('Greet() string') && hoverText.includes('Greet says hi.'),
    `hover did not show gopls's signature and doc: ${JSON.stringify(hoverText)}`,
  );
  await page.mouse.move(5, 5);

  // ── E10: breadcrumbs end with the enclosing function ──
  await placeCursor(page, main, 'helper()');
  const crumbs = await page
    .waitForFunction(
      () => {
        const segs = [...document.querySelectorAll('.breadcrumb-bar__seg--symbol')].map(
          (b) => b.lastChild?.textContent ?? '',
        );
        return segs.at(-1) === 'main' ? segs : null;
      },
      null,
      { timeout: 10_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  log(`breadcrumb symbols → ${JSON.stringify(crumbs)}`);
  assert(crumbs, 'the breadcrumb bar never ended with the symbol "main"');

  // ── E11: an agent edits a file no tab has open ──
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.tabbar [role="tab"]')) {
      if (/helper\.go|util\.go/.test(b.textContent ?? '')) b.querySelector('.tab__close')?.click();
    }
  });
  await page.waitForTimeout(300);
  writeFileSync(helper, 'package main\n\nfunc helper2() {}\n');
  await openDoc(app, page, sid, main);
  const original = await setBuffer(page, main, { from: 'helper()', to: 'helper2()' });
  const t0 = Date.now();
  let landed = null;
  while (!landed && Date.now() - t0 < 5_000) {
    await openDoc(app, page, sid, main);
    await clearTransients(page);
    await placeCursor(page, main, 'helper2');
    const r = (await trigger(page, 'f12')).after;
    if (endsWith(r.path, 'helper.go') && r.lineText.includes('func helper2')) landed = r;
  }
  log(`E11 helper2 → ${landed ? `${landed.path} "${landed.lineText}"` : 'never landed'}`);
  assert(landed, 'F12 on helper2 never reached the rewritten, unopened helper.go within 5 s');
  await openDoc(app, page, sid, main);
  await setBuffer(page, main, { whole: original });
  writeFileSync(helper, 'package main\n\nfunc helper() {}\n');

  // ── #7: palette restart ──
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill('>Restart Go language server');
  const row = page.locator('.palette__title', { hasText: /^Restart Go language server$/ });
  await row.first().waitFor({ state: 'visible', timeout: 5000 });
  await row.first().click();
  await page.waitForFunction(() => window.__lspStates.includes('stopped'), null, {
    timeout: 10_000,
  });
  log(`palette restart → states ${JSON.stringify(await page.evaluate(() => window.__lspStates))}`);
  await openDoc(app, page, sid, main);
  await clearTransients(page);
  await placeCursor(page, main, 'helper');
  // ONE F12, given the nav budget: a retry would hide a first navigation lost to the restart.
  await page.keyboard.press('F12');
  const after = await waitFor(page, (o) => endsWith(o.path, 'helper.go'), 90_000);
  log(
    `F12 after restart → ${after.path} "${after.lineText}" toasts=${JSON.stringify(after.toasts)}`,
  );
  assert(endsWith(after.path, 'helper.go'), `F12 after a palette restart landed in ${after.path}`);
}

/** E5: no gopls anywhere the host looks. `go` itself stays findable in Program Files; its
 *  GOPATH and the home dir point at an empty directory (plan "Missing-gopls e2e mechanism"). */
async function missingScenario(dir, log) {
  const empty = mkdtempSync(join(tmpdir(), 'conduit-nogopls-'));
  const sys = process.env.SystemRoot ?? 'C:\\Windows';
  const path = `${sys}\\System32;${sys}`;
  const env = {
    PATH: path,
    Path: path,
    GOPATH: empty,
    GOBIN: '',
    USERPROFILE: empty,
    HOME: empty,
  };
  const third = await launchApp({ env });
  try {
    const { app, page } = third;
    const sid = await openSession(page, { path: dir });
    const main = join(dir, 'main.go');
    await openDoc(app, page, sid, main);
    const t0 = Date.now();
    let snap = await lsp(page, { type: 'lsp:statusSnapshot' });
    while (!snap.servers.some((x) => x.state === 'absent') && Date.now() - t0 < 20_000) {
      await page.waitForTimeout(250);
      snap = await lsp(page, { type: 'lsp:statusSnapshot' });
    }
    log(`missing gopls → servers ${JSON.stringify(snap.servers)}`);
    assert(
      snap.servers.some((x) => x.state === 'absent'),
      'the host found a gopls it should not have',
    );
    // Twice inside one toast lifetime (5 s): the second F12 must not stack another toast.
    await placeCursor(page, main, 'helper');
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
    log(`missing gopls → toasts ${JSON.stringify(r.toasts)} errors ${JSON.stringify(errors)}`);
    assert(
      r.toasts.filter((t) => t === INSTALL_TOAST).length === 1,
      `expected exactly one install toast, got ${JSON.stringify(r.toasts)}`,
    );
    assert(r.toasts.length === 1, `unexpected extra toasts: ${JSON.stringify(r.toasts)}`);
    await placeCursor(page, main, 'package');
    await page.keyboard.type('x');
    const edited = await page.evaluate(() =>
      window.monaco.editor
        .getEditors()
        .some((e) => e.getModel()?.getValue().startsWith('pxackage')),
    );
    assert(edited, 'main.go was not editable with gopls missing');
    await page.keyboard.press('Control+Z');
    log('gopls missing: one install toast, no error, still editable ✓');
  } finally {
    await third.cleanup();
  }
}

runScenario('go-lsp', async ({ app, page, log }) => {
  assert(goplsInstalled(), 'go-lsp e2e needs gopls: go install golang.org/x/tools/gopls@latest');
  const dir = mkdtempSync(join(tmpdir(), 'conduit-go-'));
  writeGoFixture(dir);
  const main = join(dir, 'main.go');
  const sid = await openSession(page, { path: dir });

  // ── host: definition across files via the bridge ──
  const opened = await openGoDoc(page, main);
  log(`lsp:open → ${JSON.stringify(opened)}`);
  assert(
    opened.serverKey?.startsWith('go:'),
    `main.go got no server key: ${JSON.stringify(opened)}`,
  );
  const server = await waitReady(page, log);
  const def = await lsp(page, {
    type: 'lsp:request',
    requestId: 'def-1',
    path: main,
    version: 1,
    op: 'definition',
    line: 5,
    character: 2,
  });
  log(`definition → ${JSON.stringify(def).slice(0, 300)}`);
  assert(def.kind === 'locations', `definition reply was ${def.kind}`);
  assert(def.locations[0]?.path.endsWith('helper.go'), `landed in ${def.locations[0]?.path}`);
  assert(
    def.locations[0]?.range.start.line === 2,
    `wrong line ${def.locations[0]?.range.start.line}`,
  );
  assert(
    def.targets.some((t) => t.path.endsWith('helper.go')),
    'helper.go text not in targets',
  );
  await lsp(page, { type: 'lsp:close', path: main });
  log(`server ${server.serverKey} answered over the bridge ✓`);

  await editorScenarios(app, page, sid, dir, log);

  // ── E7: no orphans after a normal quit ──
  const live = await waitReady(page, log);
  const quitTree = recordTree(live.pid);
  log(`recorded gopls tree before quit: ${quitTree.map((p) => `${p.name}:${p.pid}`).join(', ')}`);
  assert(/gopls/i.test(quitTree[0].name), `snapshot pid ${live.pid} is not gopls`);
  await closeApp(app, page);
  const quitLeft = await survivorsAfter(quitTree, 5_000);
  assert(quitLeft.length === 0, `alive 5 s after quit: ${JSON.stringify(quitLeft)}`);
  log('no gopls orphans after a normal quit ✓');

  // ── #6 / E7: no orphans after the main process is force-killed ──
  const second = await launchApp();
  try {
    await openSession(second.page, { path: dir });
    await openGoDoc(second.page, main);
    const s2 = await waitReady(second.page, log);
    const killTree = recordTree(s2.pid);
    log(
      `recorded gopls tree before force-kill: ${killTree.map((p) => `${p.name}:${p.pid}`).join(', ')}`,
    );
    // Asked of the main process itself: Playwright's app.process() is a launcher PARENT of the
    // real Electron main on Windows, and killing it leaves the app (and gopls) running.
    const mainPid = await second.app.evaluate(() => process.pid);
    assert(
      killTree.some((p) => p.pid === s2.pid) && recordTree(mainPid).some((p) => p.pid === s2.pid),
      `gopls ${s2.pid} is not a descendant of the main process ${mainPid}`,
    );
    // No /T: only the Electron main process, as an updater or a crash would take it down.
    spawnSync('taskkill', ['/PID', String(mainPid), '/F'], { stdio: 'ignore' });
    const mainLeft = await survivorsAfter([{ pid: mainPid, name: 'electron main' }], 5_000);
    assert(mainLeft.length === 0, `the Electron main process ${mainPid} survived taskkill`);
    const killLeft = await survivorsAfter(killTree, 5_000);
    assert(
      killLeft.length === 0,
      `JOB OBJECT NEEDED — alive 5 s after the main process was force-killed: ${JSON.stringify(killLeft)}`,
    );
    log('no gopls orphans after a main-process force-kill ✓');
  } finally {
    await second.cleanup();
  }

  await missingScenario(dir, log);
});
