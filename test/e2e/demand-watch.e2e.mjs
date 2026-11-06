/**
 * Demand-driven resources, Phase 1 (docs/specs/2026-11-03-demand-driven-resources.md §7;
 * docs/plans/2026-11-03-demand-driven-resources.plan.md Task X.2): a hidden session holds no
 * folder watch and runs no git, a reported turn end refreshes it once, showing it catches up from
 * a stale cache, and a minimized window behaves like a hidden one until it is restored.
 *
 * Every count is read in MAIN, where the watches and git children live: `fs.watch` and
 * `child_process.execFile` are wrapped there (as background-resources does), keyed per repo.
 * Sessions are switched only by clicking their sidebar row, so the renderer posts `visible`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from './attention-footer-helpers.mjs';
import {
  assert,
  openChangesTab,
  openSession,
  removeDir,
  revealSessionRow,
  runScenario,
  showRightView,
  tapBridge,
  typeLine,
  waitForOutput,
} from './harness.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** Mirrors src/repo-refresh-scheduler.ts BACKGROUND_COOLDOWN_MS (an .mjs can't import the TS). */
const BACKGROUND_COOLDOWN_MS = 10_000;

function initRepo(root) {
  mkdirSync(root, { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  return root.replace(/\\/g, '/');
}

/**
 * Poll `probe` until it returns `{ ok: true, … }`; fail with `what` and the last observation.
 * Every positive condition here waits through this, never through a fixed sleep.
 */
async function until(probe, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const last = await probe();
    if (last.ok) return last;
    if (Date.now() >= deadline) assert(false, `${what} (after ${ms} ms): ${JSON.stringify(last)}`);
    await wait(100);
  }
}

runScenario('demand-watch', async ({ app, page, log }) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'conduit-demand-watch-'));
  // Runs after runScenario's teardown has stopped the app and the shells that pin these dirs.
  process.once('exit', () => {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      console.error(`[demand-watch] fixture left behind: ${fixtureRoot}: ${e?.message}`);
    }
  });
  const repoA = initRepo(join(fixtureRoot, 'repo-a'));
  const repoB = initRepo(join(fixtureRoot, 'repo-b'));
  const repoC = initRepo(join(fixtureRoot, 'repo-c'));
  // B's shell moves here before B is deleted: Windows refuses to delete a process's cwd. Empty
  // and outside every repo, so the shell's new cwd brings no repo of its own.
  const park = join(fixtureRoot, 'park');
  mkdirSync(park);

  await app.evaluate(
    (_electron, repos) => {
      const fs = process.getBuiltinModule('fs');
      const cp = process.getBuiltinModule('child_process');
      const watch = fs.watch;
      const exec = cp.execFile;
      const key = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const roots = repos.map(key);
      const owner = (p) => {
        const n = key(p);
        return roots.find((r) => n === r || n.startsWith(`${r}/`)) ?? null;
      };
      const perRepo = () => Object.fromEntries(roots.map((r) => [r, []]));
      // `live` is the open handles, `opens` every fs.watch call. `w5` is PlanWatcher's
      // `.conduit/plans` watch (spec §2.1 W5, an AC-1 exception), kept apart so it can neither fail
      // nor pass AC-1; the fixtures have no `.conduit/`, so watchDirWhilePresent only polls for it.
      const state = { live: perRepo(), opens: perRepo(), w5: perRepo(), git: perRepo() };
      globalThis.__demandWatch = state;
      fs.watch = function (file, ...args) {
        const watcher = watch.call(this, file, ...args);
        const repo = owner(file);
        if (repo) {
          const path = key(file);
          const bucket = /\/\.conduit(\/|$)/.test(path) ? state.w5 : state.live;
          const entry = { path, at: Date.now() };
          bucket[repo].push(entry);
          if (bucket === state.live) state.opens[repo].push(entry);
          watcher.once('close', () => {
            const i = bucket[repo].indexOf(entry);
            if (i >= 0) bucket[repo].splice(i, 1);
          });
        }
        return watcher;
      };
      cp.execFile = function (bin, args, options, ...rest) {
        if (/(^|[\\/])git(\.exe)?$/i.test(String(bin))) {
          const repo = owner(options?.cwd ?? '');
          if (repo)
            state.git[repo].push({
              at: Date.now(),
              args: Array.isArray(args) ? args.map(String) : [],
            });
        }
        return exec.call(this, bin, args, options, ...rest);
      };
    },
    [repoA, repoB, repoC],
  );

  const probe = (repo) =>
    app.evaluate((_electron, r) => {
      const s = globalThis.__demandWatch;
      return {
        live: s.live[r].map((e) => e.path),
        opens: s.opens[r].length,
        w5: s.w5[r].length,
        git: s.git[r],
      };
    }, norm(repo));
  const handles = async (repo) => (await probe(repo)).live.length;
  const gitCalls = async (repo) => (await probe(repo)).git;
  const resetGit = () =>
    app.evaluate(() => {
      const s = globalThis.__demandWatch;
      for (const k of Object.keys(s.git)) s.git[k] = [];
    });
  /** The change-list read (src/project-info.ts): what AC-4's "one git status" counts. */
  const changeReads = (calls) =>
    calls.filter((c) => c.args[0] === 'status' && c.args.includes('--untracked-files=all'));
  const fmt = (calls) => JSON.stringify(calls.map((c) => c.args.join(' ')));

  /** Wait until no fixture repo ran git for `quietMs`, so a count starts from rest. */
  const settleGit = (quietMs = 1500, ms = 20_000) =>
    until(
      async () => {
        const all = (await Promise.all([repoA, repoB, repoC].map(gitCalls))).flat();
        const ago = Date.now() - Math.max(0, ...all.map((c) => c.at));
        return { ok: ago >= quietMs, lastGitAgoMs: ago };
      },
      ms,
      'fixture git never went quiet',
    );

  await tapBridge(page);
  await page.evaluate(() => {
    window.__dw = { fs: [], delta: [] };
    window.agentDeck.subscribe((m) => {
      if (m.type === 'fsChanged') window.__dw.fs.push({ at: Date.now(), folders: m.folders ?? [] });
      if (m.type === 'repoDelta') window.__dw.delta.push({ at: Date.now(), msg: m });
    });
  });
  const fsChangedFor = (repo, since) =>
    page.evaluate(
      ({ root, t }) => {
        const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        return window.__dw.fs.filter((m) => m.at >= t && m.folders.some((f) => n(f) === root))
          .length;
      },
      { root: norm(repo), t: since },
    );

  const ROW = (sid) => `[data-agent-tree] .session[data-sessionid="${sid}"]`;
  const activate = async (sid) => {
    await revealSessionRow(page, sid);
    await page.locator(ROW(sid)).click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute('aria-selected') === 'true',
      ROW(sid),
      { timeout: 10_000 },
    );
  };

  const sidA = await openSession(page, { path: repoA, agentId: 'shell:cmd' });
  const sidB = await openSession(page, { path: repoB, agentId: 'shell:cmd' });
  const sidC = await openSession(page, { path: repoC, agentId: 'shell:cmd' });
  log('sessions', JSON.stringify({ sidA, sidB, sidC }));

  // ── 1. AC-1: only the shown session's repo is watched ──────────────────────
  await activate(sidA);
  await until(
    async () => {
      const [a, b, c] = await Promise.all([repoA, repoB, repoC].map(probe));
      return {
        ok: a.live.length >= 1 && b.live.length === 0 && c.live.length === 0,
        a: a.live,
        b: b.live,
        c: c.live,
      };
    },
    3000,
    'AC-1: shown A watched, hidden B and C unwatched',
  );
  log('1 ✓ AC-1 only the shown repo holds a watch');

  // ── 2. AC-2/3: writes into hidden B run no git ─────────────────────────────
  await settleGit();
  await resetGit();
  writeFileSync(join(repoB, 'seed.txt'), `seed-${Date.now()}\n`);
  writeFileSync(join(repoB, 'b-one.txt'), 'one\n');
  writeFileSync(join(repoB, 'b-two.txt'), 'two\n');
  await wait(2000);
  {
    const p = await probe(repoB);
    assert(p.git.length === 0, `AC-2/3: hidden writes ran git for B: ${fmt(p.git)}`);
    assert(p.live.length === 0, `AC-1: B gained a watch: ${JSON.stringify(p.live)}`);
  }
  log('2 ✓ AC-2/3 hidden writes run no git');

  // ── 3. AC-4: a reported turn end in hidden B refreshes it once ─────────────
  // A turn-end mark inside the hidden cooldown of B's last run arms only at lastStart + 10 s
  // (spec §3.4), outside this step's window; start the turn after it.
  {
    const lastB = Math.max(0, ...(await gitCalls(repoB)).map((c) => c.at));
    const gap = lastB + BACKGROUND_COOLDOWN_MS + 500 - Date.now();
    if (gap > 0) await wait(gap);
  }
  await resetGit();
  const completionsB = () =>
    page.evaluate(
      (sid) => (window.__sessions || []).find((s) => s.id === sid)?.completions ?? null,
      sidB,
    );
  const before = await completionsB();
  assert(Number.isInteger(before), `B carries no completions counter: ${before}`);
  await report(page, sidB, 'working');
  await report(page, sidB, 'done');
  await until(
    async () => {
      const n = await completionsB();
      return { ok: n > before, completions: n, before };
    },
    10_000,
    'B never completed a reported run',
  );
  const doneSeenAt = Date.now();
  await until(
    async () => {
      const calls = await gitCalls(repoB);
      return { ok: changeReads(calls).length >= 1, calls: fmt(calls) };
    },
    3000,
    'AC-4: no change-list refresh for hidden B after its turn end',
  );
  // Long enough for a duplicate or an echoed run to land behind the first.
  await wait(1500);
  {
    const calls = await gitCalls(repoB);
    const reads = changeReads(calls);
    assert(reads.length === 1, `AC-4: want exactly one status for B, got ${fmt(calls)}`);
    assert(
      reads[0].args.includes('--porcelain') && reads[0].args.includes('-z'),
      `AC-4: B's refresh is not the change-list read: ${fmt(reads)}`,
    );
    const numstat = calls.filter((c) => c.args[0] === 'diff' && c.args.includes('--numstat'));
    assert(numstat.length === 0, `AC-4: the hidden refresh counted lines: ${fmt(numstat)}`);
    const live = (await probe(repoB)).live;
    assert(live.length === 0, `AC-1: B gained a watch from its turn end: ${JSON.stringify(live)}`);
  }
  await page
    .waitForFunction(
      ({ sid, root }) => {
        const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const s = (window.__sessions || []).find((x) => x.id === sid);
        const g = Object.entries(s?.repoGit ?? {}).find(([k]) => n(k) === root)?.[1];
        return g?.kind === 'branch' && !!g.branch && g.dirty === true;
      },
      { sid: sidB, root: norm(repoB) },
      { timeout: Math.max(500, doneSeenAt + 3000 - Date.now()), polling: 100 },
    )
    .catch(async () => {
      const g = await page.evaluate(
        (sid) => (window.__sessions || []).find((x) => x.id === sid)?.repoGit,
        sidB,
      );
      assert(false, `AC-4: B's state never carried branch + dirty: ${JSON.stringify(g)}`);
    });
  log('3 ✓ AC-4 one status, no lines, repoGit branch + dirty for hidden B');

  // ── 4. AC-13: a plain shell's commands in hidden C run no git ──────────────
  await settleGit();
  await resetGit();
  for (let i = 0; i < 10; i++) await typeLine(page, sidC, `echo dw-c-${i}`);
  await waitForOutput(page, sidC, 'dw-c-9');
  await wait(3000);
  {
    const calls = await gitCalls(repoC);
    assert(calls.length === 0, `AC-13: hidden plain shell ran git for C: ${fmt(calls)}`);
  }
  log('4 ✓ AC-13 hidden plain-shell commands run no git');

  // ── 5. AC-5: showing B sends a stale cache, then catches up ────────────────
  // Changes is opened while A is still shown, so the view is mounted before B's first full delta
  // and the badge cannot come and go before anything observes it.
  await openChangesTab(page);
  await until(
    async () => ({ ok: (await page.locator('.repo-head__stale').count()) === 0 }),
    5000,
    'a stale badge is up before B is shown',
  );
  writeFileSync(join(repoB, 'late.txt'), `late-${Date.now()}\n`);
  await page.evaluate(() => {
    const badge = { seenAt: null, goneAt: null };
    window.__dwBadge = badge;
    const check = () => {
      const up = document.querySelector('.repo-head__stale') !== null;
      if (up && badge.seenAt === null) badge.seenAt = Date.now();
      if (!up && badge.seenAt !== null && badge.goneAt === null) badge.goneAt = Date.now();
    };
    window.__dwBadgeObserver?.disconnect();
    window.__dwBadgeObserver = new MutationObserver(check);
    window.__dwBadgeObserver.observe(document.body, { childList: true, subtree: true });
  });
  const clickAt = Date.now();
  await activate(sidB);
  const deltasB = () =>
    page.evaluate(
      ({ sid, root, t }) => {
        const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        return window.__dw.delta
          .filter((d) => d.at >= t && d.msg.sessionId === sid)
          .map((d) => {
            const snap = Object.entries(d.msg.repos ?? {}).find(([k]) => n(k) === root)?.[1];
            return {
              at: d.at,
              full: d.msg.full === true,
              has: snap !== undefined && !snap.removed,
              stale: snap?.stale === true,
              late: (snap?.changes ?? []).some((c) => n(c.path).split('/').pop() === 'late.txt'),
            };
          });
      },
      { sid: sidB, root: norm(repoB), t: clickAt },
    );
  const { full: firstFull } = await until(
    async () => {
      const ds = await deltasB();
      return { ok: ds.some((d) => d.full), full: ds.find((d) => d.full), ds };
    },
    5000,
    'AC-5: no full repoDelta for B after it was shown',
  );
  assert(
    firstFull.has && firstFull.stale,
    `AC-5: B's first full delta on show is not a stale cache: ${JSON.stringify(firstFull)}`,
  );
  const { hit: fresh } = await until(
    async () => {
      const ds = await deltasB();
      const hit = ds.find((d) => d.at >= firstFull.at && d.has && !d.stale && d.late);
      return { ok: hit !== undefined, hit, ds };
    },
    Math.max(0, firstFull.at + 1500 - Date.now()),
    'AC-5: B never listed late.txt fresh within 1.5 s of the stale send',
  );
  const badge = await until(
    async () => {
      const b = await page.evaluate(() => window.__dwBadge);
      return { ok: b.seenAt !== null && b.goneAt !== null, ...b };
    },
    Math.max(500, fresh.at + 1000 - Date.now()),
    'AC-5: the stale badge did not appear and then clear',
  );
  await page.evaluate(() => window.__dwBadgeObserver?.disconnect());
  assert(
    (await fsChangedFor(repoB, clickAt)) >= 1,
    'AC-5: showing B sent no fsChanged for its root',
  );
  log(
    `5 ✓ AC-5 stale full send, fresh ${fresh.at - firstFull.at} ms later, badge up ${badge.seenAt - clickAt}..${badge.goneAt - clickAt} ms after the click`,
  );

  // ── 6. AC-6: a minimized window releases A, restore catches it up ──────────
  await activate(sidA);
  await until(
    async () => ({ ok: (await handles(repoA)) >= 1 && (await handles(repoB)) === 0 }),
    3000,
    'A re-watched and B released after switching back',
  );
  await settleGit();
  const minimized = await app.evaluate((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    globalThis.__dwMinimizeSeen = false;
    win.once('minimize', () => {
      globalThis.__dwMinimizeSeen = true;
    });
    win.minimize();
    // Under CONDUIT_E2E the window was created with show:false, and a window that was never shown
    // cannot be iconified — show it only so it can immediately go to the taskbar.
    if (!win.isMinimized()) {
      win.show();
      win.minimize();
    }
    return win.isMinimized();
  });
  assert(minimized === true, 'the window did not minimize');
  await until(
    async () => {
      const seen = await app.evaluate(() => globalThis.__dwMinimizeSeen);
      const live = (await probe(repoA)).live;
      return { ok: seen && live.length === 0, minimizeEvent: seen, live };
    },
    1000,
    'AC-6: minimizing did not release the watch of A',
  );
  await resetGit();
  const minAt = Date.now();
  writeFileSync(join(repoA, 'while-min.txt'), `min-${Date.now()}\n`);
  await wait(2000);
  {
    const calls = await gitCalls(repoA);
    assert(calls.length === 0, `AC-6: git ran for A while minimized: ${fmt(calls)}`);
    assert((await fsChangedFor(repoA, minAt)) === 0, 'AC-6: fsChanged for A while minimized');
  }
  // main.ts's `restore` listener is the show path under test (setSuspended(false) wakes the demand
  // `run`; windowRestored marks and sends full). `hide` has no listener, so it must come after.
  await app.evaluate((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    globalThis.__dwRestoreSeen = false;
    win.once('restore', () => {
      globalThis.__dwRestoreSeen = true;
    });
    win.restore();
  });
  await until(
    () =>
      app.evaluate((electron) => ({
        ok:
          globalThis.__dwRestoreSeen === true &&
          !electron.BrowserWindow.getAllWindows()[0].isMinimized(),
        restoreEvent: globalThis.__dwRestoreSeen,
      })),
    2000,
    'the window never emitted restore',
  );
  // No visible window may stay up on the machine running the suite.
  await app.evaluate((electron) => electron.BrowserWindow.getAllWindows()[0].hide());
  await until(
    async () => {
      const p = await probe(repoA);
      return { ok: p.git.length >= 1 && p.live.length >= 1, git: fmt(p.git), live: p.live };
    },
    2000,
    'AC-6: restore did not re-watch and refresh A',
  );
  await showRightView(page, 'files');
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.filerow__name')].some(
          (el) => (el.textContent ?? '').trim() === 'while-min.txt',
        ),
      null,
      { timeout: 10_000, polling: 100 },
    )
    .catch(() => assert(false, 'AC-6: the Files tree never showed while-min.txt after restore'));
  log('6 ✓ AC-6 minimize releases A; restore re-watches, refreshes and lists the new file');

  // ── 7. AC-8 with G1: deleting hidden B opens nothing ───────────────────────
  const marker = `DWPARK${Date.now()}`;
  await typeLine(page, sidB, `cd /d "${park}" && echo ${marker}`);
  await waitForOutput(page, sidB, marker);
  await until(
    async () => {
      const live = (await probe(repoB)).live;
      return { ok: live.length === 0, live };
    },
    3000,
    'B holds a watch while hidden, before the delete',
  );
  const opensBefore = (await probe(repoB)).opens;
  await removeDir(repoB, { budgetMs: 10_000 });
  await wait(2000);
  {
    const p = await probe(repoB);
    assert(p.live.length === 0, `AC-8: deleted hidden B holds a watch: ${JSON.stringify(p.live)}`);
    assert(
      p.opens === opensBefore,
      `AC-8: deleting hidden B opened ${p.opens - opensBefore} new watch(es)`,
    );
  }
  log('7 ✓ AC-8 deleting hidden B opens no watch');
});
