/**
 * A session opened through an 8.3 short-name alias (`C:\Users\RUNNER~1\...`) behaves like one
 * opened through the long path: saves, Explorer create/rename, HTML preview and the repo's git
 * state all work. Before the fix every write was refused "(symlink)" — `realPathLeaf` expands the
 * alias while the stored root kept it. See src/short-names.ts.
 *
 * Needs a directory that HAS an 8.3 alias; volumes with short-name generation off only have the
 * ones created before it was turned off. `CONDUIT_E2E_SHORT_BASE` names one explicitly; otherwise
 * TEMP, the home dir and their children are probed. None found → SKIP, never a vacuous pass.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assert, finishScenario, openSession, runScenario } from './harness.mjs';

const NAME = 'short-path-root';

if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only`);
  await finishScenario(0);
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** `dir` itself when it is an alias of a longer path, else null. */
function aliasOf(dir) {
  try {
    const long = realpathSync.native(dir);
    return same(long, dir) ? null : { short: dir, long };
  } catch {
    return null;
  }
}

function shortFormOf(dir) {
  try {
    const out = execFileSync(
      'cmd.exe',
      ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`],
      {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      },
    ).trim();
    return aliasOf(out);
  } catch {
    return null;
  }
}

/** Child directories of `dir` that carry an 8.3 name, read from `dir /x`. */
function aliasedChildren(dir) {
  let listing = '';
  try {
    listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/ad', dir], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const out = [];
  for (const line of listing.split(/\r?\n/)) {
    const m = /<DIR>\s+(\S*~\S*)\s+(.+)$/.exec(line);
    if (!m) continue;
    const found = aliasOf(join(dir, m[1]));
    if (found && same(basename(found.long), m[2].trim())) out.push(found);
  }
  return out;
}

function findShortBase() {
  const explicit = process.env.CONDUIT_E2E_SHORT_BASE;
  if (explicit) return aliasOf(explicit);
  for (const dir of [tmpdir(), homedir()]) {
    const own = shortFormOf(dir);
    if (own) return own;
  }
  for (const dir of [tmpdir(), homedir()]) {
    const [first] = aliasedChildren(dir);
    if (first) return first;
  }
  return null;
}

const base = findShortBase();
if (!base) {
  console.log(`[${NAME}] SKIP — no directory with an 8.3 alias on this machine`);
  await finishScenario(0);
}

/** Created inside the scenario, after the e2e lock: a run killed while waiting leaks nothing. */
function makeFixture() {
  const longRoot = mkdtempSync(join(base.long, 'conduit sp '));
  process.on('exit', () => rmSync(longRoot, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: longRoot, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(longRoot, 'a.txt'), 'one\n');
  writeFileSync(join(longRoot, 'index.html'), '<!doctype html><title>sp</title><p>short path</p>');
  mkdirSync(join(longRoot, 'sub'));
  writeFileSync(join(longRoot, 'sub', 'b.txt'), 'b\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return { longRoot, shortRoot: join(base.short, basename(longRoot)) };
}

const bridge = (page, fn, arg) => page.evaluate(fn, arg);

runScenario(NAME, async ({ page, log }) => {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  const { longRoot, shortRoot } = makeFixture();
  log('alias', { short: shortRoot, long: longRoot });
  const sid = await openSession(page, { path: shortRoot });

  const session = await page
    .waitForFunction(
      (id) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return s?.repos && s.repos.length > 0 ? s : null;
      },
      sid,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue());
  const home = session.home;
  log(
    'stored home',
    home,
    'repos',
    session.repos.map((r) => r.root),
  );
  check(same(home, longRoot), `home stored as the long path, got ${home}`);

  const write = await bridge(
    page,
    (p) => window.agentDeck.writeFile(p, 'two\n'),
    join(home, 'a.txt'),
  );
  log('writeFile', write);
  check(write.ok, `save inside the session refused: ${write.error}`);

  const create = await bridge(
    page,
    (p) => window.agentDeck.fsMutate({ op: 'createFile', path: p }),
    join(home, 'sub', 'new.txt'),
  );
  log('createFile', create);
  check(create.ok, `Explorer new file refused: ${create.error}`);

  const rename = await bridge(
    page,
    ([from, to]) => window.agentDeck.fsMutate({ op: 'rename', from, to }),
    [join(home, 'sub', 'new.txt'), join(home, 'sub', 'renamed.txt')],
  );
  log('rename', rename);
  check(rename.ok, `Explorer rename refused: ${rename.error}`);
  check(existsSync(join(longRoot, 'sub', 'renamed.txt')), 'rename did not land on disk');

  const preview = await bridge(
    page,
    (p) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(null), 10000);
        const requestId = `sp-${Date.now()}`;
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'html:canPreviewResult' && m.requestId === requestId) {
            off?.();
            resolve(m.result);
          }
        });
        window.agentDeck.post({ type: 'html:canPreview', requestId, path: p });
      }),
    join(home, 'index.html'),
  );
  log('canPreview', preview);
  check(preview?.ok, `preview refused: ${preview?.reason} ${preview?.detail ?? ''}`);

  const repoRoot = session.repos[0].root;
  const repoGit = await page
    .waitForFunction(
      ({ id, r }) => {
        const s = (window.__sessions || []).find((x) => x.id === id);
        return s?.repoGit?.[r] ?? null;
      },
      { id: sid, r: repoRoot },
      { timeout: 10000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  log('repoGit', repoRoot, repoGit);
  check(repoGit, `no git state keyed by the session's repo root ${repoRoot}`);

  writeFileSync(join(longRoot, 'sub', 'b.txt'), 'b edited outside Conduit\n');
  const project = await bridge(
    page,
    ({ p, r, id }) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(null), 10000);
        const requestId = Math.floor(Math.random() * 1e9);
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'project' && m.requestId === requestId) {
            off?.();
            resolve(m.repoChanges ?? null);
          }
        });
        window.agentDeck.post({
          type: 'requestProject',
          path: p,
          changesRoot: r,
          sessionId: id,
          requestId,
        });
      }),
    { p: home, r: repoRoot, id: sid },
  );
  log('repoChanges', JSON.stringify(project));
  const changed = (project ?? []).flatMap((rc) => rc.changes.map((c) => c.path));
  check(
    changed.some((p) => /a\.txt$/.test(p)),
    `the saved a.txt is missing from the repo's changes: ${JSON.stringify(changed)}`,
  );
  check(
    changed.some((p) => /b\.txt$/.test(p)),
    `an outside edit to sub/b.txt is missing from the repo's changes: ${JSON.stringify(changed)}`,
  );

  const diff = await bridge(
    page,
    (p) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(null), 10000);
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'fileDiff' && m.doc.path === p) {
            off?.();
            resolve(m.doc);
          }
        });
        window.agentDeck.post({ type: 'readDiff', path: p });
      }),
    join(home, 'sub', 'b.txt'),
  );
  log('readDiff', diff && { path: diff.path, head: diff.head, work: diff.work });
  check(
    diff?.head === 'b\n',
    `the diff's HEAD side of sub/b.txt is ${JSON.stringify(diff?.head)}, not the committed text`,
  );
  assert(failures.length === 0, failures.join('; '));
});
