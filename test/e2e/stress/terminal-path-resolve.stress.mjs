/**
 * Terminal path-link resolve budget (plan docs/plans/2026-10-16-terminal-path-links.plan.md
 * Slice 6): a session over a non-git folder of 30 repos × 50 files and one over 200 repos × 10
 * files, each repo holding src/index.ts. After 5 warm-up posts, 50 `resolvePathToken` posts of 10
 * mixed tokens (exact, exact-root fan-out, suffix, elision, misses) are timed renderer-side.
 * Budget: warm p95 ≤ 50 ms at 30 roots and ≤ 150 ms at 200 (gated only on an idle machine; a
 * busy one reports SKIPPED, never a looser number).
 *
 * Advisory, never gated: the p95 of 20 `readFile` round trips for a ~50 KB file, alone and while
 * the 200-root burst is in flight — a ratio above 2× is main-thread contention worth reporting.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario } from '../harness.mjs';
import {
  assertInvariant,
  emitReport,
  openSession,
  startPerf,
  stopPerf,
} from './harness-stress.mjs';
import { machineIdle, makeRepoFarm, waitForFirstFill } from './multi-repo-harness.mjs';

const NAME = 'terminal-path-resolve';
const WARMUP = 5;
const POSTS = 50;
const READS = 20;
const BUDGET_P95_MS = { 30: 50, 200: 150 };

const root = mkdtempSync(join(tmpdir(), 'conduit-path-resolve-'));
process.once('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.error(`[${NAME}] fixture cleanup failed, left at ${root}:`, e?.message || e);
  }
});

function farm(name, repos, filesPerRepo) {
  const ws = join(root, name);
  const dirs = makeRepoFarm(ws, { repos, filesPerRepo });
  for (const dir of dirs) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    // Left untracked: the composite index lists untracked, unignored files too, and a second
    // commit per repo would double the fixture time inside the lane's per-scenario budget.
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');
  }
  return ws.replace(/\\/g, '/');
}

const buildStart = Date.now();
const ws30 = farm('ws30', 30, 50);
const ws200 = farm('ws200', 200, 10);
const bigFile = join(root, 'big.txt').replace(/\\/g, '/');
writeFileSync(bigFile, `${'x'.repeat(99)}\n`.repeat(512));
const buildMs = Date.now() - buildStart;
const idle = await machineIdle();

const TOKENS = [
  'repo-000/src/index.ts',
  'src/index.ts',
  'seed-1.txt',
  'index.ts',
  '…/src/index.ts',
  'repo-002/seed-3.txt',
  'repo-001/seed-2.txt',
  'nope/x.ts',
  'zzz-missing.ts',
  'src/nope.ts',
].map((t) => ({ alts: [t] }));
// A dir token is stat'ed in every root by design (plan resolver rule 4: the index lists files
// only), so its cost is measured apart from the budgeted mix (advisory).
const DIR_TOKENS = [...TOKENS.slice(0, 9), { alts: ['src/'] }];
const DIR_POSTS = 10;

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null;
};

/** Sequential round trips, timed in the renderer; ids from `base` so the pane's own never match. */
function timeResolves(page, sid, n, base, tokens = TOKENS) {
  return page.evaluate(
    async ({ s, n, tokens, base }) => {
      const times = [];
      for (let i = 0; i < n; i++) {
        const requestId = base + i;
        const t0 = performance.now();
        await new Promise((resolve) => {
          const off = window.agentDeck.subscribe((m) => {
            if (m.type === 'resolvePathTokenResult' && m.requestId === requestId) {
              off();
              resolve(m);
            }
          });
          window.agentDeck.post({ type: 'resolvePathToken', sessionId: s, requestId, tokens });
        });
        times.push(performance.now() - t0);
      }
      return times;
    },
    { s: sid, n, tokens, base },
  );
}

/** `READS` sequential readFile round trips; with `burst`, `POSTS` resolves are fired first and
 *  left in flight. */
function timeReads(page, sid, burst) {
  return page.evaluate(
    async ({ s, path, reads, burst, posts, tokens }) => {
      if (burst) {
        for (let i = 0; i < posts; i++) {
          window.agentDeck.post({
            type: 'resolvePathToken',
            sessionId: s,
            requestId: 800000 + i,
            tokens,
          });
        }
      }
      const times = [];
      for (let i = 0; i < reads; i++) {
        const t0 = performance.now();
        await new Promise((resolve) => {
          const off = window.agentDeck.subscribe((m) => {
            if (
              m.type === 'fileContent' &&
              m.doc.path.replace(/\\/g, '/').toLowerCase() === path.toLowerCase()
            ) {
              off();
              resolve(null);
            }
          });
          window.agentDeck.post({ type: 'readFile', path });
        });
        times.push(performance.now() - t0);
      }
      return times;
    },
    { s: sid, path: bigFile, reads: READS, burst, posts: POSTS, tokens: TOKENS },
  );
}

runScenario(NAME, async ({ page, log }) => {
  log(`fixture ${buildMs}ms, machine busy=${idle.busy} idle=${idle.idle}`);
  const results = {};
  let sid200 = '';
  for (const [n, ws] of [
    [30, ws30],
    [200, ws200],
  ]) {
    const sid = await openSession(page, { path: ws });
    if (n === 200) sid200 = sid;
    const scanned = await page
      .waitForFunction(
        ({ id, want }) => {
          const got = (window.__sessions || []).find((s) => s.id === id)?.repos?.length ?? 0;
          return got >= want ? got : false;
        },
        { id: sid, want: n },
        { timeout: 90000, polling: 250 },
      )
      .then((h) => h.jsonValue());
    assertInvariant(scanned === n, `expected ${n} repos, scanned ${scanned}`);
    // Warm means after the tracker's first git pass, which otherwise competes with every stat.
    await waitForFirstFill(page, sid, n);
    await timeResolves(page, sid, WARMUP, 700000 + n * 1000);
    await startPerf(page, `${NAME}-${n}`);
    const times = await timeResolves(page, sid, POSTS, 710000 + n * 1000);
    const perf = await stopPerf(page);
    const dirTimes = await timeResolves(page, sid, DIR_POSTS, 720000 + n * 1000, DIR_TOKENS);
    results[n] = {
      p50: pct(times, 50),
      p95: pct(times, 95),
      max: pct(times, 100),
      withDirTokenP95: pct(dirTimes, 95),
      perf,
    };
    log(
      `${n} roots: warm p50=${results[n].p50}ms p95=${results[n].p95}ms max=${results[n].max}ms; ` +
        `with a dir token p95=${results[n].withDirTokenP95}ms (advisory)`,
    );
  }

  const readIdle = await timeReads(page, sid200, false);
  const readBusy = await timeReads(page, sid200, true);
  const readFile = { idle: pct(readIdle, 95), underResolve: pct(readBusy, 95) };
  const ratio = readFile.idle
    ? Math.round((readFile.underResolve / readFile.idle) * 100) / 100
    : null;
  log(
    `readFile p95 idle=${readFile.idle}ms underResolve=${readFile.underResolve}ms ratio=${ratio}`,
  );

  for (const n of [30, 200]) {
    const { perf, ...numbers } = results[n];
    // The readFile probe ran against the 200-root session, so it rides that report.
    const reads =
      n === 200
        ? { 'readFile.idle': readFile.idle, 'readFile.underResolve': readFile.underResolve, ratio }
        : {};
    emitReport(`${NAME}-${n}`, perf, {
      idle,
      buildMs,
      ...numbers,
      budgetP95: BUDGET_P95_MS[n],
      ...reads,
    });
  }

  if (!idle.idle) {
    log(`SKIPPED budget check: machine busy=${idle.busy}`);
    return;
  }
  for (const n of [30, 200]) {
    assertInvariant(
      results[n].p95 <= BUDGET_P95_MS[n],
      `${n}-root warm resolve p95 ${results[n].p95}ms over the ${BUDGET_P95_MS[n]}ms budget`,
    );
  }
});
