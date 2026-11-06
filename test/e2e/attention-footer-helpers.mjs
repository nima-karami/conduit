/**
 * Shared drivers for the sidebar-done-seen and status-bar scenarios (spec
 * docs/specs/2026-11-02-sidebar-agent-tree.md §4, §7). NOT a scenario — the runner only picks up
 * `*.e2e.mjs`. Every producer here is the real server's: a qualifying burst for the heuristic run
 * end, an OSC 7501 report for the reported one, a bare BEL for the bell reason.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C2 } from './c2-peer.mjs';
import { assert, REPO, typeLine } from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SPAWN_GRACE_MS (5 s) plus margin: output before it is startup noise, never a completion. */
export const SPAWN_GRACE_WAIT_MS = 6_500;
/** ATTENTION_QUIET_MS (4 s) + one 750 ms sweep, with room for a loaded runner. */
const COMPLETION_WITHIN_MS = 15_000;
/** How long a "stays" check watches: many renders and several sweeps, so a clear would show. */
export const STAYS_MS = 2_500;

/**
 * A run that qualifies by bytes (>= MIN_RUN_BYTES) in one burst. The marker is concatenated in
 * the child so the shell's echo of the typed line can never satisfy a wait on it.
 */
const burstLine = (tag) =>
  `node -e "process.stdout.write('x'.repeat(4000)+String.fromCharCode(10)+'${tag}'+'-done'+String.fromCharCode(10))"`;

/** Type one qualifying burst into a cmd session and wait until the child has printed it. */
export async function burst(page, sid, tag) {
  await typeLine(page, sid, burstLine(tag));
  await page.waitForFunction(
    ({ s, t }) => (window.__capBy?.[s] ?? '').includes(`${t}-done`),
    { s: sid, t: tag },
    { timeout: 20_000 },
  );
}

/**
 * Emit one OSC 7501 status report from a cmd session. hc marks the terminal `reported` from then
 * on, so the server drops this session's output heuristics for good: use a session of its own.
 * @param {'idle' | 'working' | 'done' | 'blocked'} state
 */
export function report(page, sid, state) {
  return typeLine(
    page,
    sid,
    `node -e "process.stdout.write(String.fromCharCode(27)+']7501;state=${state}'+String.fromCharCode(7))"`,
  );
}

/** One bare BEL from a cmd session, nothing else. */
export function bell(page, sid) {
  return typeLine(page, sid, `node -e "process.stdout.write(String.fromCharCode(7))"`);
}

/** The session as the server last broadcast it (`tapBridge`'s `window.__sessions`). */
export const sessionOf = (page, sid) =>
  page.evaluate((id) => (window.__sessions || []).find((s) => s.id === id) ?? null, sid);

/** The server's completion counter for one session. */
export async function completionsOf(page, sid) {
  return (await sessionOf(page, sid))?.completions ?? null;
}

/** Wait until the server's counter for `sid` reads exactly `n`; throws with the last value. */
export async function waitCompletions(page, sid, n, what, ms = COMPLETION_WITHIN_MS) {
  await page
    .waitForFunction(
      ({ id, want }) => (window.__sessions || []).find((s) => s.id === id)?.completions === want,
      { id: sid, want: n },
      { timeout: ms },
    )
    .catch(async () => {
      assert(false, `${what}: completions ${await completionsOf(page, sid)}, want ${n}`);
    });
}

const ROW = (sid) => `[data-agent-tree] .session[data-sessionid="${sid}"]`;

/**
 * The row's own status word, read from its accessible name "<name>, <status>[, …]". The name is
 * taken from the session itself, so a comma inside a name cannot shift the parse.
 */
export function rowState(page, sid) {
  return page.evaluate(
    ({ sel, id }) => {
      const label = document.querySelector(sel)?.getAttribute('aria-label');
      const name = (window.__sessions || []).find((s) => s.id === id)?.name;
      if (!label || !name || !label.startsWith(`${name}, `)) return null;
      return label.slice(name.length + 2).split(', ')[0];
    },
    { sel: ROW(sid), id: sid },
  );
}

/** Wait until the row's status word is `state`; throws with the last label. */
export async function waitRowState(page, sid, state, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  let got = null;
  while (Date.now() < deadline) {
    got = await rowState(page, sid);
    if (got === state) return;
    await sleep(100);
  }
  assert(false, `${what}: row reads ${JSON.stringify(got)}, want ${JSON.stringify(state)}`);
}

/** Fail the moment the row's status word leaves `state` within `ms`. */
export async function assertRowStays(page, sid, state, what, ms = STAYS_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await rowState(page, sid);
    assert(got === state, `${what}: row went ${JSON.stringify(got)}, must stay ${state}`);
    await sleep(100);
  }
}

/**
 * The status group a row sits in. The tree is one flat list (header, rows, header, …), so a row's
 * group is the nearest header before it.
 */
export function groupOf(page, sid) {
  return page.evaluate((sel) => {
    let el = document.querySelector(sel);
    while (el) {
      el = el.previousElementSibling;
      const g = el?.getAttribute('data-agent-group');
      if (g) return g;
    }
    return null;
  }, ROW(sid));
}

/** Make a session active through its row's select button and wait for the row to read selected. */
export async function selectRow(page, sid) {
  await page.locator(`${ROW(sid)} [data-agent-action="select"]`).click();
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('aria-selected') === 'true',
    ROW(sid),
    { timeout: 5_000 },
  );
}

/** Run one entry of a row's context menu by its exact label. */
export async function rowMenu(page, sid, label) {
  await page.locator(ROW(sid)).click({ button: 'right' });
  await page.locator('.ctxmenu__item', { hasText: label }).first().click();
}

/**
 * Put keyboard focus in one of the two shown terminals: the active one, or the split (the only
 * termhost carrying a bar). That focus is what App reads as the viewed terminal.
 * @param {'active' | 'split'} which
 */
export async function focusTerminal(page, which) {
  const ok = await page.evaluate((w) => {
    const hosts = Array.from(document.querySelectorAll('.termstack > .termhost')).filter(
      (h) => h instanceof HTMLElement && h.style.display !== 'none',
    );
    const host = hosts.find(
      (h) => !!h.querySelector(':scope > .termhost__bar') === (w === 'split'),
    );
    const input = host?.querySelector('.xterm-helper-textarea');
    if (!(input instanceof HTMLElement)) return false;
    input.focus();
    return document.activeElement === input;
  }, which);
  assert(ok, `could not focus the ${which} terminal`);
}

/**
 * The window-level half of the strict viewed rule (spec §4): App reads `document.hasFocus()` and
 * `document.visibilityState`, and an e2e window is created hidden (show:false) with Playwright's
 * focus emulation on, so neither is ours to set without showing a window on the user's screen or
 * relying on an OS foreground the remote runner does not have. App exposes an e2e-only seam for
 * exactly that fact; the terminal-focus and center-view halves stay real.
 * @param {boolean | null} looking  null hands the fact back to the document
 */
export async function setWindowLooking(page, looking) {
  // App installs the seam once the host's state says e2e, which a fresh document has not yet seen.
  const installed = await page
    .waitForFunction(() => typeof window.__conduitWindowLooking === 'function', null, {
      timeout: 10_000,
    })
    .then(
      () => page.evaluate((v) => window.__conduitWindowLooking(v), looking).then(() => true),
      () => false,
    );
  assert(
    installed,
    'App has no window.__conduitWindowLooking seam (CONDUIT_E2E only; see sidebar-done-seen header)',
  );
}

/** What the document itself reports, for the log: the hidden-window facts the seam stands in for. */
export const documentLooking = (page) =>
  page.evaluate(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState }));

// Same selector as harness `statusItem(page, 'attention')`, as a string so each read runs in one
// page.evaluate. A count() then a locator read races the item unmounting, and the locator read
// auto-waits to a 30 s timeout instead of reporting the item gone.
const ATTENTION_SEL = 'footer[data-status-bar] [data-status-item="attention"]';

/** The footer need-you button's text and tooltip, or null when it is not shown. */
export function footerAttention(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return { text: (el.textContent ?? '').trim(), title: el.getAttribute('title') ?? '' };
  }, ATTENTION_SEL);
}

/**
 * Wait until the footer need-you button reads `text` (null: absent); throws with the last read.
 * The predicate returns the snapshot it matched, so the value returned is the one that satisfied
 * the wait rather than a second read the item may already have left.
 */
export async function waitFooterAttention(page, text, what, ms = 10_000) {
  const handle = await page
    .waitForFunction(
      ({ sel, want }) => {
        const el = document.querySelector(sel);
        const snap = el
          ? { text: (el.textContent ?? '').trim(), title: el.getAttribute('title') ?? '' }
          : null;
        return (snap?.text ?? null) === want ? { snap } : false;
      },
      { sel: ATTENTION_SEL, want: text },
      { timeout: ms },
    )
    .catch(() => null);
  if (!handle) {
    const last = await footerAttention(page);
    assert(
      false,
      `${what}: footer attention ${JSON.stringify(last)}, want text ${JSON.stringify(text)}`,
    );
  }
  return (await handle.jsonValue()).snap;
}

const APP_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

/**
 * Ask the profile's own Conduit server for `server.restart` over a fresh C2 connection, as
 * server-restart-supervisor does; resolves once that connection has closed. The app's supervisor
 * lookup then starts a new server, whose attention counters begin at zero.
 */
export async function restartServer(userDataDir) {
  const { serverEndpoint } = teardownNames(userDataDir, 'win32', tmpdir());
  const c2 = await C2.open(serverEndpoint);
  const closed = new Promise((resolve) => c2.socket.once('close', resolve));
  await c2.call('hello', { appVersion: APP_VERSION, generation: SERVER_PROTOCOL_GENERATION });
  // The server may drop the connection before it answers, which C2 reports as a rejection.
  const outcome = c2.call('server.restart', { reason: 'user' }).then(
    (result) => ({ result }),
    (error) => ({ error: error.message }),
  );
  await closed;
  return outcome;
}

/**
 * Keep typing a marker until the session's child prints it: after a server restart the app
 * reconnects with a backoff of its own, and input while it is down is dropped by design.
 */
export async function resyncAfterRestart(page, sid, ms = 45_000) {
  const deadline = Date.now() + ms;
  for (let n = 1; Date.now() < deadline; n++) {
    const tag = `resync${n}`;
    await typeLine(page, sid, `node -e "console.log('${tag}'+'-ok')"`);
    const ok = await page
      .waitForFunction(
        ({ s, t }) => (window.__capBy?.[s] ?? '').includes(`${t}-ok`),
        { s: sid, t: tag },
        { timeout: 2_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (ok) return;
  }
  assert(false, `session ${sid} never took input again after the server restart`);
}
