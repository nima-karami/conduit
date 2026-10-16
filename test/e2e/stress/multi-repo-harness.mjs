/**
 * Fixtures, load and observers for the multi-repo stress scenarios
 * (docs/specs/2026-10-16-multi-repo-tracking.md §7). Fixtures are built under a caller-supplied
 * OS-temp root; nothing here writes into the repository.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';
import { numstatCalls, statusCalls } from '../git-probe.mjs';
import { gitCommitAll, initGitRepo } from './harness-stress.mjs';

const AGENT_FILE = /^agent-\d+-\d+\.txt$/;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });

function seedRepo(dir, filesPerRepo) {
  initGitRepo(dir);
  // Thousands of LF→CRLF warnings on stderr overflow run-stress's 1 MB spawnSync buffer.
  git(dir, 'config', 'core.autocrlf', 'false');
  for (let i = 0; i < filesPerRepo; i++) writeFileSync(join(dir, `seed-${i}.txt`), `seed ${i}\n`);
  gitCommitAll(dir, 'seed');
  return dir;
}

/** `repos` committed repos directly under `root` (which is not itself a repo). */
export function makeRepoFarm(root, { repos, filesPerRepo }) {
  mkdirSync(root, { recursive: true });
  const out = [];
  for (let i = 0; i < repos; i++) {
    out.push(seedRepo(join(root, `repo-${String(i).padStart(3, '0')}`), filesPerRepo));
  }
  return out;
}

/**
 * The ticket workflow (spec §1): `repos` main repos under `<root>/ws`, and `tickets` ticket dirs
 * under it, each holding `worktreesPerTicket` linked worktrees of distinct main repos. Opening
 * the workspace therefore scans repos + tickets × worktreesPerTicket repos.
 */
export function makeTicketTopology(
  root,
  { repos = 20, filesPerRepo = 1500, tickets = 4, worktreesPerTicket = 4 } = {},
) {
  const workspace = join(root, 'ws');
  const mains = makeRepoFarm(workspace, { repos, filesPerRepo });
  const out = [];
  for (let k = 0; k < tickets; k++) {
    const dir = join(workspace, `ticket-${k}`);
    mkdirSync(dir, { recursive: true });
    const worktrees = [];
    for (let j = 0; j < worktreesPerTicket; j++) {
      const main = mains[(k * worktreesPerTicket + j) % mains.length];
      const name = basename(main);
      const branch = `t${k}-${name}`;
      const wt = join(dir, name);
      git(main, 'worktree', 'add', '-q', '-b', branch, wt);
      worktrees.push({ dir: wt, main, branch });
    }
    out.push({ dir, worktrees });
  }
  return { workspace, repos: mains, tickets: out };
}

/**
 * One scripted "agent" per dir: every tick a new untracked `agent-<i>-<seq>.txt` and an append
 * to the tracked `seed-0.txt`. Resolves with every write, stamped when it hit the disk.
 */
export function startWriters(dirs, { intervalMs = 200, durationMs = 10000 } = {}) {
  const writes = [];
  const seq = dirs.map(() => 0);
  return new Promise((resolve) => {
    const tick = () => {
      dirs.forEach((dir, i) => {
        const name = `agent-${i}-${seq[i]++}.txt`;
        writeFileSync(join(dir, name), `${name}\n`);
        appendFileSync(join(dir, 'seed-0.txt'), `${name}\n`);
        writes.push({ dir, name, at: Date.now() });
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    setTimeout(() => {
      clearInterval(timer);
      resolve(writes);
    }, durationMs);
  });
}

/**
 * Records, per session, when each agent file first appears in a change list the renderer was
 * sent: today's pulled `project` reply (attributed by its path to the session whose cwd/home it
 * is, since the reply carries no session id) and the engine's pushed `repoDelta`. Also keeps a
 * bounded log of the agent names in each message, so a scenario can see a name drop out.
 */
export async function installChangeObserver(page) {
  await page.evaluate((pattern) => {
    if (window.__changeObserver) return;
    window.__changeObserver = true;
    const agent = new RegExp(pattern);
    const norm = (p) =>
      String(p ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
    const base = (p) => String(p).split(/[\\/]/).pop() ?? '';
    window.__firstSeen = {};
    window.__refreshedAt = {};
    window.__changeMsgs = {};
    const record = (sid, paths, refreshedAt) => {
      const now = Date.now();
      window.__firstSeen[sid] ??= {};
      window.__refreshedAt[sid] ??= {};
      window.__changeMsgs[sid] ??= [];
      const seen = window.__firstSeen[sid];
      const refreshed = window.__refreshedAt[sid];
      const log = window.__changeMsgs[sid];
      const names = [];
      for (const p of paths) {
        const name = base(p);
        if (!agent.test(name)) continue;
        names.push(name);
        seen[name] ??= now;
        if (refreshedAt !== undefined) refreshed[name] ??= refreshedAt;
      }
      log.push({ at: now, names });
      if (log.length > 50) log.shift();
    };
    window.agentDeck.subscribe((m) => {
      if (m.type === 'project' && Array.isArray(m.repoChanges)) {
        const at = norm(m.path);
        const owner = (window.__sessions || []).find(
          (s) => norm(s.cwd) === at || norm(s.home) === at,
        );
        if (!owner) return;
        record(
          owner.id,
          m.repoChanges.flatMap((r) => r.changes.map((c) => c.path)),
          undefined,
        );
      } else if (m.type === 'repoDelta') {
        for (const snap of Object.values(m.repos ?? {})) {
          record(
            m.sessionId,
            (snap?.changes ?? []).map((c) => c.path),
            snap?.refreshedAt,
          );
        }
      }
    });
  }, AGENT_FILE.source);
}

export async function readFirstSeen(page) {
  return page.evaluate(() => window.__firstSeen ?? {});
}

export async function readRefreshedAt(page) {
  return page.evaluate(() => window.__refreshedAt ?? {});
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Arrival lag: first renderer sighting − write time, over the writes this session saw. */
export function lagStats(writes, seenBySession, sessionId) {
  const seen = seenBySession[sessionId] ?? {};
  const lags = writes
    .filter((w) => seen[w.name] !== undefined)
    .map((w) => seen[w.name] - w.at)
    .sort((a, b) => a - b);
  return {
    n: writes.length,
    seen: lags.length,
    p50: percentile(lags, 50),
    p95: percentile(lags, 95),
    max: lags.length ? lags[lags.length - 1] : null,
  };
}

/** Spec §7 lag: refreshedAt(first repoDelta naming the file) − write time. Empty before the engine. */
export function refreshLagStats(writes, refreshedBySession, sessionId) {
  const at = refreshedBySession[sessionId] ?? {};
  const lags = writes
    .filter((w) => at[w.name] !== undefined)
    .map((w) => at[w.name] - w.at)
    .sort((a, b) => a - b);
  return {
    n: lags.length,
    p95: percentile(lags, 95),
    max: lags.length ? lags[lags.length - 1] : null,
  };
}

const cpuTotals = () =>
  cpus().reduce(
    (acc, c) => {
      const t = c.times;
      acc.busy += t.user + t.nice + t.sys + t.irq;
      acc.all += t.user + t.nice + t.sys + t.irq + t.idle;
      return acc;
    },
    { busy: 0, all: 0 },
  );

/** os.cpus() busy fraction sampled over `ms` before launch; idle = busy < maxBusy. */
export async function machineIdle({ ms = 2000, maxBusy = 0.3 } = {}) {
  const a = cpuTotals();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTotals();
  const busy = b.all > a.all ? (b.busy - a.busy) / (b.all - a.all) : 0;
  return { idle: busy < maxBusy, busy: Math.round(busy * 1000) / 1000 };
}

/** Opens `sessionId` in the split pane via its card context menu "Open in split pane". */
export async function openSplit(page, sessionId) {
  await page.locator(`.session[data-sessionid="${sessionId}"]`).click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  await page.locator('.ctxmenu .ctxmenu__item', { hasText: 'Open in split pane' }).first().click();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.termpane')).filter((el) => el.offsetWidth > 0)
        .length >= 2,
    null,
    { timeout: 10000 },
  );
}

/** ms until the session's repoGit holds an interrogation for `repoCount` repos. */
export async function waitForFirstFill(page, sessionId, repoCount, { timeout = 120000 } = {}) {
  const t0 = Date.now();
  await page.waitForFunction(
    ({ sid, n }) => {
      const s = (window.__sessions || []).find((x) => x.id === sid);
      return Object.keys(s?.repoGit ?? {}).length >= n;
    },
    { sid: sessionId, n: repoCount },
    { timeout, polling: 100 },
  );
  return Date.now() - t0;
}

/** Host event-loop drift: the git spawning and watching all happen on main's thread. */
export async function startHostLag(app) {
  await app.evaluate(() => {
    if (globalThis.__hostLag) clearInterval(globalThis.__hostLag.timer);
    const lag = { gaps: [], last: Date.now() };
    lag.timer = setInterval(() => {
      const now = Date.now();
      lag.gaps.push(Math.max(0, now - lag.last - 20));
      lag.last = now;
    }, 20);
    globalThis.__hostLag = lag;
  });
}
export async function readHostLag(app) {
  const gaps = await app.evaluate(() => {
    const g = globalThis.__hostLag?.gaps ?? [];
    if (globalThis.__hostLag) globalThis.__hostLag.gaps = [];
    return g;
  });
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.ceil((p / 100) * sorted.length) - 1] : null);
  return {
    p95: at(95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    totalMs: sorted.reduce((s, x) => s + x, 0),
  };
}

export function gitStats(calls, writtenKeys, settleEnd, idleWindowMs = 3000) {
  const status = statusCalls(calls);
  const perCwd = new Map();
  for (const c of status) perCwd.set(c.cwd, (perCwd.get(c.cwd) ?? 0) + 1);
  const outside = status.filter((c) => !writtenKeys.has(c.cwd));
  return {
    gitTotal: calls.length,
    statusTotal: status.length,
    numstatTotal: numstatCalls(calls).length,
    statusPerRepoMax: Math.max(0, ...[...writtenKeys].map((k) => perCwd.get(k) ?? 0)),
    statusCwds: perCwd.size,
    statusOutsideWritten: outside.length,
    statusOutsideWrittenCwds: new Set(outside.map((c) => c.cwd)).size,
    idleGitAfter: calls.filter((c) => c.at > settleEnd - idleWindowMs && c.at <= settleEnd).length,
  };
}
