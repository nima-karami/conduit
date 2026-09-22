/**
 * Go navigation through a host-owned gopls, end to end against the real binary
 * (docs/specs/2026-09-22-language-server-go.md §7.2).
 *
 * Host level: definition over the bridge, and no gopls (or descendant) outlives the app — after a
 * normal quit AND after only the Electron main process is force-killed. The force-kill case is
 * the one that decides whether a Windows Job object is needed (spec §2.4); it is not a flake to
 * retry past.
 *
 * Needs gopls installed: `go install golang.org/x/tools/gopls@latest`.
 * Run: node test/e2e/run-smoke.mjs go-lsp   (needs `npm run build` first)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, openSession, runScenario } from './harness.mjs';

const READY_CEILING_MS = 120_000;

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

runScenario('go-lsp', async ({ app, page, log }) => {
  assert(goplsInstalled(), 'go-lsp e2e needs gopls: go install golang.org/x/tools/gopls@latest');
  const dir = mkdtempSync(join(tmpdir(), 'conduit-go-'));
  writeGoFixture(dir);
  const main = join(dir, 'main.go');
  await openSession(page, { path: dir });

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

  // ── E7: no orphans after a normal quit ──
  const quitTree = recordTree(server.pid);
  log(`recorded gopls tree before quit: ${quitTree.map((p) => `${p.name}:${p.pid}`).join(', ')}`);
  assert(/gopls/i.test(quitTree[0].name), `snapshot pid ${server.pid} is not gopls`);
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
});
