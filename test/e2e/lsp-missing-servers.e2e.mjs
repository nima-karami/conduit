/**
 * AC-B1 (docs/specs/2026-10-08-language-coverage.md §7): with no Python, Rust or C/C++ server
 * anywhere the host looks, F12 in each shows exactly one install toast naming the server and its
 * hint, no error toast, and the files stay editable. A `.h` beside the `.cpp` is the same clangd
 * server, so it adds no second toast.
 *
 * PATH is System32 only, and every home and %ProgramFiles% point at one empty dir — the go-lsp E5
 * mechanism. clangd's win32 search dir derives from %ProgramFiles%, so the runner's own LLVM is
 * hidden with no test hook. Needs no server installed; runs in core smoke.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeClangdFixture } from './clangd-fixture.mjs';
import { clearTransients, observe, openDoc, placeCursor } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import { errorToasts, lsp, waitObserved, waitServerState } from './lsp-fixture.mjs';
import { writePythonFixture } from './python-fixture.mjs';
import { writeRustFixture } from './rust-fixture.mjs';

const TOASTS = {
  python:
    'Python navigation needs basedpyright-langserver — install with `pip install basedpyright`',
  rust: 'Rust navigation needs rust-analyzer — install with `rustup component add rust-analyzer`',
  cpp: 'C/C++ navigation needs clangd — install with `winget install LLVM.LLVM`',
};

const empty = mkdtempSync(join(tmpdir(), 'conduit-noservers-'));
const sys = process.env.SystemRoot ?? 'C:\\Windows';
const path = `${sys}\\System32;${sys}`;
const env = {
  PATH: path,
  Path: path,
  HOME: empty,
  USERPROFILE: empty,
  APPDATA: empty,
  CARGO_HOME: empty,
  ProgramFiles: empty,
};

/** F12 twice inside one toast lifetime; exactly the one install toast may show. */
async function f12Toast(page, file, token, want, log) {
  await placeCursor(page, file, token);
  await page.keyboard.press('F12');
  await waitObserved(page, (o) => o.toasts.includes(want), 8_000);
  await page.keyboard.press('F12');
  await page.waitForTimeout(1_000);
  const { toasts } = await observe(page);
  const errors = await errorToasts(page);
  log(`F12 in ${file} → toasts ${JSON.stringify(toasts)} errors ${JSON.stringify(errors)}`);
  assert(
    toasts.length === 1 && toasts[0] === want,
    `expected exactly one install toast ${JSON.stringify(want)}, got ${JSON.stringify(toasts)}`,
  );
  assert(errors.length === 0, `error toasts: ${JSON.stringify(errors)}`);
}

async function assertEditable(page, file, token, typed) {
  await placeCursor(page, file, token);
  await page.keyboard.type('x');
  const edited = await page.evaluate(
    ({ p, t }) =>
      window.monaco.editor
        .getEditors()
        .some(
          (e) =>
            e.getModel()?.uri.path.toLowerCase() === `/${p.toLowerCase()}` &&
            e.getModel()?.getValue().includes(t),
        ),
    { p: file.replace(/\\/g, '/'), t: typed },
  );
  assert(edited, `${file} was not editable with its server missing`);
  await page.keyboard.press('Control+Z');
}

runScenario(
  'lsp-missing-servers',
  async ({ app, page, log }) => {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-missing-'));
    const py = writePythonFixture(join(dir, 'py'));
    const rs = writeRustFixture(join(dir, 'rs'));
    const cpp = writeClangdFixture(join(dir, 'cpp'));
    const sid = await openSession(page, { path: dir });

    await openDoc(app, page, sid, py.main);
    await waitServerState(page, 'python', 'absent', log, 20_000);
    await f12Toast(page, py.main, 'greet(', TOASTS.python, log);
    await assertEditable(page, py.main, 'from', 'fxrom');
    await clearTransients(page);

    await openDoc(app, page, sid, rs.main);
    await waitServerState(page, 'rust', 'absent', log, 20_000);
    await f12Toast(page, rs.main, 'greet(', TOASTS.rust, log);
    await assertEditable(page, rs.main, 'fn main', 'fxn main');
    await clearTransients(page);

    await openDoc(app, page, sid, cpp.main);
    await waitServerState(page, 'cpp', 'absent', log, 20_000);
    await placeCursor(page, cpp.main, 'greet(');
    await page.keyboard.press('F12');
    await waitObserved(page, (o) => o.toasts.includes(TOASTS.cpp), 8_000);
    await openDoc(app, page, sid, cpp.header);
    await f12Toast(page, cpp.header, 'twice', TOASTS.cpp, log);
    const snap = await lsp(page, { type: 'lsp:statusSnapshot' });
    const clangd = snap.servers.filter((s) => s.languageId === 'cpp');
    assert(
      clangd.length === 1 && clangd[0].state === 'absent',
      `.h + .cpp should share one absent clangd record: ${JSON.stringify(clangd)}`,
    );
    await assertEditable(page, cpp.header, 'static', 'sxtatic');
    log('B1 every server missing: one install toast each, .h + .cpp one clangd, still editable ✓');
  },
  { env },
);
