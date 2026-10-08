/**
 * Host-side language-server helpers shared by every LSP scenario: the bridge call, process-tree
 * snapshots, status waits, the host's trust flow and an install probe
 * (docs/plans/2026-10-08-language-coverage.plan.md Task B5.1).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { observe, pointOn } from './goto-matrix.mjs';
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

/** `pid` and every descendant, by ParentProcessId walk. */
export function recordTree(pid) {
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
