/**
 * Host-side language-server helpers shared by every LSP scenario: the bridge call, process-tree
 * snapshots, status waits, the host's trust flow and an install probe
 * (docs/plans/2026-10-08-language-coverage.plan.md Task B5.1).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { observe, openDoc, pointOn } from './goto-matrix.mjs';
import { assert } from './harness.mjs';

export const lsp = (page, msg) => page.evaluate((m) => window.agentDeck.lsp(m), msg);

export const endsWith = (p, suffix) => (p ?? '').toLowerCase().endsWith(suffix.toLowerCase());

/** `observe` until `pred` holds or `ms` runs out; returns the last observation either way. */
export async function waitObserved(page, pred, ms) {
  const deadline = Date.now() + ms;
  let last = await observe(page);
  while (Date.now() < deadline) {
    if (pred(last)) return last;
    await page.waitForTimeout(150);
    last = await observe(page);
  }
  return last;
}

export function errorToasts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.toast--error .toast__msg, .toast.error')).map(
      (e) => e.textContent,
    ),
  );
}

/** Hover `token` with a real mouse and return the first hover text containing `needle`. */
export async function hoverText(page, path, token, needle) {
  const hp = await pointOn(page, path, token);
  await page.mouse.move(hp.x - 60, hp.y + 60);
  await page.mouse.move(hp.x, hp.y, { steps: 4 });
  const text = await page
    .waitForFunction(
      (want) =>
        [...document.querySelectorAll('.monaco-hover')]
          .map((e) => e.textContent ?? '')
          .find((t) => t.includes(want)) ?? null,
      needle,
      { timeout: 30_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  await page.mouse.move(5, 5);
  return text;
}

/** The breadcrumb bar's symbol segments once one equals `symbol`, or null. */
export function breadcrumbWith(page, symbol) {
  return page
    .waitForFunction(
      (want) => {
        const segs = [...document.querySelectorAll('.breadcrumb-bar__seg--symbol')].map(
          (b) => b.lastChild?.textContent ?? '',
        );
        return segs.some((s) => s === want || s.startsWith(`${want}(`)) ? segs : null;
      },
      symbol,
      { timeout: 30_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
}

function processList() {
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
  return JSON.parse(json);
}

/** `pid` and every descendant, by ParentProcessId walk. */
export function recordTree(pid, procs = processList()) {
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

export async function survivorsAfter(tree, ms) {
  const deadline = Date.now() + ms;
  let left = tree;
  while (Date.now() < deadline) {
    left = tree.filter((p) => alive(p.pid));
    if (left.length === 0) return [];
    await new Promise((r) => setTimeout(r, 200));
  }
  return left;
}

/** A server status for `languageId` (the PRIMARY id statuses carry) once one is in `state`;
 *  fails early on absent/crashed when waiting for anything else. `match` narrows by root. */
export async function waitServerState(page, languageId, state, log, ms = 30_000, match = null) {
  const t0 = Date.now();
  let snap = null;
  while (Date.now() - t0 < ms) {
    snap = await lsp(page, { type: 'lsp:statusSnapshot' });
    const mine = snap.servers.filter((s) => s.languageId === languageId && (!match || match(s)));
    const hit = mine.find((s) => s.state === state);
    if (hit) {
      log(
        `${languageId} ${state} in ${((Date.now() - t0) / 1000).toFixed(1)}s (pid ${hit.pid}, root ${hit.root})`,
      );
      return hit;
    }
    if (state !== 'absent' && state !== 'crashed') {
      const bad = mine.find((s) => s.state === 'absent' || s.state === 'crashed');
      assert(!bad, `${languageId} server went ${bad?.state}: ${JSON.stringify(bad)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(
    false,
    `${languageId} never reached ${state} within ${ms / 1000}s: ${JSON.stringify(snap?.servers)}`,
  );
}

/** Definition over the bridge until the server's project load answers it — `ready` means
 *  initialized, and the project may still be loading. */
export async function waitDefinition(page, path, line, character, log, ms) {
  const t0 = Date.now();
  let last = null;
  let n = 0;
  while (Date.now() - t0 < ms) {
    last = await lsp(page, {
      type: 'lsp:request',
      requestId: `def-${++n}`,
      path,
      version: 1,
      op: 'definition',
      line,
      character,
    });
    if (last.kind === 'locations' && last.locations.length > 0) {
      log(`definition answered after ${((Date.now() - t0) / 1000).toFixed(1)}s (${n} asks)`);
      return last;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  assert(false, `no definition within ${ms / 1000}s: ${JSON.stringify(last)}`);
}

/** Trust through the host's own prompt flow — what the prompt's Trust button sends. */
export async function trustViaHost(page, path, languageId, log) {
  const asked = await lsp(page, { type: 'lsp:trustRequest', path, languageId });
  assert(asked.ok, `trust request refused for ${path}`);
  const t0 = Date.now();
  let state = await lsp(page, { type: 'lsp:trustState' });
  while (!state.prompt && Date.now() - t0 < 10_000) {
    await new Promise((r) => setTimeout(r, 100));
    state = await lsp(page, { type: 'lsp:trustState' });
  }
  assert(state.prompt, 'the host raised no trust prompt');
  const answered = await lsp(page, {
    type: 'lsp:trustAnswer',
    promptId: state.prompt.id,
    choice: 'trust',
  });
  assert(answered.ok, 'the host refused the trust answer');
  log(`trusted ${state.prompt.folder} through the host prompt`);
}

/** Whether `binary` (a name on PATH, or an absolute path) runs `args` cleanly. The host's own
 *  lookup is richer (lsp-registry); this only tells installed from not. */
export function serverInstalled(binary, args) {
  const r = spawnSync(binary, args, { stdio: 'ignore', timeout: 30_000, windowsHide: true });
  return r.status === 0;
}

// ── Residency (docs/plans/2026-10-08-language-coverage.plan.md Task C4.2) ──

/** src/lsp-residency.ts EVICT_MIN_HIDDEN_MS — never shortened by a hook (plan C4.2). */
export const EVICT_MIN_HIDDEN_MS = 60_000;
const HEAVY = new Set(['rust', 'cpp', 'csharp']);
const LIVE = new Set(['starting', 'loading', 'ready', 'restarting']);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live server statuses (the snapshot drops stopped ones) for `languageId`. */
export async function liveServers(page, languageId) {
  const snap = await lsp(page, { type: 'lsp:statusSnapshot' });
  return snap.servers.filter((s) => s.languageId === languageId && LIVE.has(s.state));
}

/** Every 250 ms: record each heavy server the host reports, and count how many are still alive —
 *  a server being alive while ANY process of its tree is, so an evictee still exiting counts, and
 *  so does the real rust-analyzer behind the rustup proxy the host spawned (AC-C1). Trees are
 *  re-walked about once a second; a server whose whole tree is gone is dropped. */
export function heavySampler(page, log) {
  /** server pid → { lang, pids } */
  const servers = new Map();
  const langs = new Set();
  let maxAlive = 0;
  let samples = 0;
  let stopped = false;
  let lastLine = '';
  const done = (async () => {
    while (!stopped) {
      const snap = await lsp(page, { type: 'lsp:statusSnapshot' }).catch(() => null);
      for (const s of snap?.servers ?? []) {
        if (!HEAVY.has(s.languageId) || s.pid === null || servers.has(s.pid)) continue;
        servers.set(s.pid, { lang: s.languageId, pids: new Set([s.pid]) });
        langs.add(s.languageId);
      }
      if (samples % 4 === 0 && servers.size > 0) {
        const procs = processList();
        for (const [root, srv] of servers) {
          for (const p of recordTree(root, procs)) srv.pids.add(p.pid);
        }
      }
      for (const [root, srv] of servers) {
        if (![...srv.pids].some(alive)) servers.delete(root);
      }
      maxAlive = Math.max(maxAlive, servers.size);
      samples++;
      const line = [...servers]
        .map(([root, srv]) => `${srv.lang}:${root}(+${srv.pids.size - 1})`)
        .join(' ');
      if (line !== lastLine) {
        log(`heavy servers alive → [${line}]`);
        lastLine = line;
      }
      await sleep(250);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await done;
      return { maxAlive, samples, langs: [...langs] };
    },
  };
}

/** Working set (MB) of each pid, for the run's measured numbers. */
export function workingSetsMb(pids) {
  if (pids.length === 0) return {};
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $([math]::Round($_.WorkingSet64 / 1MB))" }`,
    ],
    { encoding: 'utf8' },
  );
  return Object.fromEntries(
    out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split(' ').map(Number)),
  );
}

/** AC-C1's setup: `.rs` shown (t0), `.cpp` shown (t1), then — once `.rs` has been hidden 61 s —
 *  `.cs` opened from the `.cpp` tab. Asserts rust-analyzer was evicted (the LRU), clangd kept
 *  (hidden ~0 s, hysteresis) and csharp-ls started. `fx` holds the three fixtures' paths. */
export async function reachRustEvicted(app, page, sid, fx, log) {
  await openDoc(app, page, sid, fx.rs.lib);
  await openDoc(app, page, sid, fx.rs.main);
  const rust = await waitServerState(page, 'rust', 'ready', log, 90_000);
  await openDoc(app, page, sid, fx.cpp.main);
  const t1 = Date.now();
  const cpp = await waitServerState(page, 'cpp', 'ready', log, 60_000);
  log(`working sets (MB) rust+cpp → ${JSON.stringify(workingSetsMb([rust.pid, cpp.pid]))}`);
  await sleep(Math.max(0, t1 + EVICT_MIN_HIDDEN_MS + 1_000 - Date.now()));
  await openDoc(app, page, sid, fx.cs.program);
  const shownCs = Date.now();
  let cs = [];
  let rustLeft = [rust];
  while (Date.now() - shownCs < 20_000) {
    cs = (await liveServers(page, 'csharp')).filter((s) => s.pid !== null);
    rustLeft = await liveServers(page, 'rust');
    if (cs.length > 0 && rustLeft.length === 0) break;
    await sleep(250);
  }
  log(`after .cs: rust ${JSON.stringify(rustLeft)} csharp ${JSON.stringify(cs)}`);
  assert(rustLeft.length === 0, `rust-analyzer (LRU, hidden 61 s) was not evicted`);
  assert(cs.length === 1, 'csharp-ls did not start');
  const cppNow = await liveServers(page, 'cpp');
  assert(
    cppNow.length === 1 && cppNow[0].pid === cpp.pid,
    `clangd (hidden < 60 s) was not kept: ${JSON.stringify(cppNow)}`,
  );
  log(`working sets (MB) cpp+cs → ${JSON.stringify(workingSetsMb([cpp.pid, cs[0].pid]))}`);
  return { shownCs, cpp: cpp.pid, cs: cs[0].pid };
}
