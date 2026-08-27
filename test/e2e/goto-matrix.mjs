/**
 * Shared driver for the Go to Definition flow-map matrix
 * (docs/specs/2026-08-21-goto-definition-flows.md).
 *
 * NOT a scenario — the runner only picks up `*.e2e.mjs`. The matrix is split across several
 * scenarios (first-party / config / packages / feedback / cap) because one app launch driving
 * all 45 rows runs past the runner's per-scenario guard.
 *
 * Two things make the matrix readable as evidence rather than as a pass/fail bit:
 *   - every row records what it OBSERVED (landed path + line text, peek, toast, Monaco's own
 *     inline message), not just whether it matched; and
 *   - a failing row does not abort the scenario. Rows are collected, printed as a table, and
 *     the scenario exits non-zero at the end. Asserting the SPEC'S TARGET means most rows are
 *     expected to fail against the pre-fix build — the table is the deliverable.
 */

import { assert } from './harness.mjs';

/** Bounded wait for one navigation. The wrapper's own deadline is 6 s. */
const NAV_SETTLE_MS = 7000;
const NAV_POLL_MS = 150;
/** How long the post-change observation may keep moving before it is read anyway. */
const NAV_QUIESCE_MS = 4000;

/** How long to wait for the streamed index to report its final chunk. */
const INDEX_READY_MS = 120000;

// ──────────────────────────────────────────────────────────────────────────────
// Index observation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Record the `projectFiles` stream the same way `ts-index-state` does, so a scenario can
 * wait for "indexed" rather than guessing at a sleep. Install BEFORE opening the session.
 */
export async function tapIndex(page) {
  await page.evaluate(() => {
    if (window.__idxTapped) return;
    window.__idxTapped = true;
    window.__idx = {
      chunks: 0,
      total: 0,
      done: false,
      root: null,
      skipped: 0,
      capped: 0,
      supplemental: 0,
      roots: {},
    };
    window.agentDeck.subscribe((m) => {
      if (m.type !== 'projectFiles') return;
      // MORE THAN ONE ROOT streams into a scenario: the harness's own session indexes the app's
      // repo alongside the fixture. `skipped`/`capped` are per-root, so the tap has to sum them
      // exactly like `ts-index-state` does — keeping the last chunk's numbers reads whichever
      // root happened to finish last.
      const prev = window.__idx.roots[m.root] ?? {};
      const roots = {
        ...window.__idx.roots,
        [m.root]: {
          total: m.supplemental ? (prev.total ?? 0) + m.total : m.total,
          skipped: m.skipped ?? 0,
          capped: m.capped ?? 0,
        },
      };
      const sum = (key) => Object.values(roots).reduce((n, r) => n + (r[key] ?? 0), 0);
      window.__idx = {
        chunks: window.__idx.chunks + 1,
        total: m.total,
        done: m.done,
        root: m.root,
        skipped: sum('skipped'),
        capped: sum('capped'),
        supplemental: window.__idx.supplemental + (m.supplemental ? 1 : 0),
        roots,
      };
    });
  });
}

export async function waitForIndexReady(page, log) {
  await page.waitForFunction(() => window.__idx?.done === true, null, { timeout: INDEX_READY_MS });
  const idx = await page.evaluate(() => window.__idx);
  log?.(
    `index complete: ${idx.total} files in ${idx.chunks} chunk(s) · skipped ${idx.skipped} · capped ${idx.capped} · roots ${JSON.stringify(idx.roots)}`,
  );
  return idx;
}

/**
 * Wait for a top-up chunk beyond the ones already seen — the `fsChanged` → incremental index
 * path (row 35). Deterministic on purpose: the round trip is watcher debounce + renderer
 * debounce + a `git ls-files` on the host, and a fixed sleep long enough to cover that on a
 * loaded machine would be long enough to hide a regression on a quiet one.
 */
export async function waitForSupplementalIndex(page, seenBefore, timeout = 30000) {
  await page.waitForFunction((n) => (window.__idx?.supplemental ?? 0) > n, seenBefore, { timeout });
  return page.evaluate(() => window.__idx);
}

/** How many top-up chunks the tap has recorded so far. */
export function supplementalCount(page) {
  return page.evaluate(() => window.__idx?.supplemental ?? 0);
}

/** Wait until the stream has STARTED but not finished — the window row 45 lives in. */
export async function waitForIndexStarted(page) {
  await page.waitForFunction(() => (window.__idx?.chunks ?? 0) > 0, null, { timeout: 60000 });
  return page.evaluate(() => window.__idx);
}

// ──────────────────────────────────────────────────────────────────────────────
// Opening files
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Open a file as a doc tab through the host's own `openFileInEditor` route — the same
 * `openFile(path, …)` the explorer click calls, with the path spelled exactly as given (which
 * is what row 42 is about). Driving the tree instead costs one expand per directory level and
 * the matrix opens ~40 files.
 */
export async function openDoc(app, page, sessionId, absPath) {
  const p = absPath.replace(/\\/g, '/');
  await app.evaluate(
    (electron, { path, sid }) => {
      const w = electron.BrowserWindow.getAllWindows()[0];
      w?.webContents.send('to-webview', { type: 'openFileInEditor', path, sessionId: sid });
    },
    { path: p, sid: sessionId },
  );
  await page.waitForFunction(
    (want) =>
      (window.monaco?.editor.getEditors() ?? []).some(
        (e) => e.getModel()?.uri.path.toLowerCase() === `/${want.toLowerCase()}`,
      ),
    p,
    { timeout: 20000 },
  );
  // The model exists; give React the tick it needs to make this doc the active tab.
  await page.waitForTimeout(150);
}

/**
 * Expand the explorer down to `absPath` and click the leaf — the REAL tree open path, which is
 * what row 42 compares the navigation's path key against.
 *
 * Rows are matched on `data-path`, not on the row's label: the tree is virtualized and its
 * labels carry decoration, so a text selector is both fragile and ambiguous. The click itself
 * is a real mouse click at the row's own coordinates (a synthesized `el.click()` would skip
 * exactly the overlay bugs this suite exists to catch).
 */
export async function openViaTree(page, rootPath, relParts) {
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  const root = rootPath.replace(/\\/g, '/');
  const levels = relParts.map((_, i) => `${root}/${relParts.slice(0, i + 1).join('/')}`);
  const leaf = levels[levels.length - 1];
  for (const level of levels) {
    // Opening a file reveals it, so the tree is often ALREADY expanded past this level from an
    // earlier row. Clicking an expanded directory would collapse it — skip ahead to the leaf.
    if (level !== leaf && (await findRow(page, leaf, 1))) break;
    const at = await findRow(page, level);
    if (!at) {
      const seen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.filerow'))
          .slice(0, 8)
          .map((r) => r.dataset.path ?? '(no data-path)'),
      );
      throw new Error(`openViaTree: no row for ${level}; visible rows: ${seen.join(', ')}`);
    }
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
  }
  const at = await findRow(page, leaf);
  if (!at) throw new Error(`openViaTree: leaf row ${leaf} never appeared`);
  // Double-click, i.e. PIN the tab. A single click opens a preview tab, which the next open
  // replaces in place — that alone would hide a duplicate-tab bug from row 42.
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForTimeout(400);
  return leaf;
}

/**
 * Locate one tree row by `data-path`, scanning the virtualized list: only rows intersecting the
 * viewport are mounted, so a row above or below the current scroll simply does not exist in the
 * DOM until the scroller is moved.
 */
async function findRow(page, wantPath, passes = 3) {
  const probe = () =>
    page.evaluate((want) => {
      const row = Array.from(document.querySelectorAll('.filerow')).find(
        (r) => (r.dataset.path ?? '').replace(/\\/g, '/').toLowerCase() === want.toLowerCase(),
      );
      if (!row) return null;
      row.scrollIntoView({ block: 'nearest' });
      const b = row.getBoundingClientRect();
      return b.height > 0 ? { x: b.left + 24, y: b.top + b.height / 2 } : null;
    }, wantPath);

  for (let pass = 0; pass < passes; pass++) {
    const at = await probe();
    if (at) return at;
    // Mounting is driven by a React state update from the scroll event, so each step has to
    // give the renderer a turn before the next probe — a scroll sweep inside one evaluate
    // would run entirely before a single new row exists.
    const geom = await page.evaluate(() => {
      const first = document.querySelector('.filerow');
      const scroller = first?.closest('[class*="scroll"]') ?? first?.parentElement;
      return scroller
        ? { height: scroller.clientHeight, total: scroller.scrollHeight, top: scroller.scrollTop }
        : null;
    });
    if (!geom) return null;
    const step = Math.max(60, geom.height - 40);
    for (let top = 0; top <= geom.total; top += step) {
      await page.evaluate((t) => {
        const first = document.querySelector('.filerow');
        const scroller = first?.closest('[class*="scroll"]') ?? first?.parentElement;
        if (scroller) scroller.scrollTop = t;
      }, top);
      await page.waitForTimeout(120);
      const hit = await probe();
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Close every doc tab. A dirty tab raises the app's own save/discard alertdialog — whose
 * backdrop then swallows every later click — so the discard is answered here rather than
 * leaving the scenario wedged behind an invisible modal.
 */
export async function closeAllDocs(page) {
  for (let i = 0; i < 60; i++) {
    const n = await page.evaluate(() => {
      const btn = document.querySelector('.tabbar [role="tab"] .tab__close');
      if (!btn) return 0;
      btn.click();
      return 1;
    });
    if (!n) break;
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      const dlg = document.querySelector('[role="alertdialog"]');
      if (!dlg) return;
      const buttons = Array.from(dlg.querySelectorAll('button'));
      const discard = buttons.find((b) => /discard/i.test(b.textContent ?? ''));
      (discard ?? buttons[buttons.length - 1])?.click();
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Observation
// ──────────────────────────────────────────────────────────────────────────────

/** Everything a row needs to judge an outcome, read in one page round-trip. */
export function observe(page) {
  return page.evaluate(() => {
    const eds = window.monaco?.editor.getEditors() ?? [];
    const outer = eds.filter((e) => {
      const n = e.getDomNode();
      return n && !n.closest('.zone-widget');
    });
    const ed = outer[outer.length - 1] ?? eds[eds.length - 1] ?? null;
    const model = ed?.getModel() ?? null;
    const pos = ed?.getPosition() ?? null;
    return {
      path: model ? model.uri.path.replace(/^\/+/, '') : null,
      line: pos?.lineNumber ?? null,
      column: pos?.column ?? null,
      lineText: model && pos ? model.getLineContent(pos.lineNumber).trim() : '',
      editors: eds.length,
      tabs: Array.from(document.querySelectorAll('.tabbar [role="tab"]')).map((el) => ({
        title: el.querySelector('span')?.textContent ?? '',
        active: el.getAttribute('aria-selected') === 'true',
      })),
      peek: !!document.querySelector('.monaco-editor .zone-widget'),
      overlay: document.querySelector('.monaco-editor-overlaymessage')?.textContent?.trim() ?? '',
      toasts: Array.from(document.querySelectorAll('.toast__msg')).map((e) =>
        (e.textContent ?? '').trim(),
      ),
    };
  });
}

function changed(a, b) {
  return (
    a.path !== b.path ||
    a.line !== b.line ||
    a.column !== b.column ||
    a.tabs.length !== b.tabs.length ||
    a.peek !== b.peek ||
    a.overlay !== b.overlay ||
    a.toasts.length !== b.toasts.length
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Triggering a navigation
// ──────────────────────────────────────────────────────────────────────────────

/** Put the cursor on the `nth` occurrence of `token` in the file that is open as `absPath`. */
export async function placeCursor(page, absPath, token, nth = 0) {
  const p = absPath.replace(/\\/g, '/');
  const ok = await page.evaluate(
    ({ path, tok, n }) => {
      const ed = (window.monaco?.editor.getEditors() ?? []).find(
        (e) => e.getModel()?.uri.path.toLowerCase() === `/${path.toLowerCase()}`,
      );
      const model = ed?.getModel();
      if (!ed || !model) return false;
      const text = model.getValue();
      let off = -1;
      for (let i = 0; i <= n; i++) off = text.indexOf(tok, off + 1);
      if (off < 0) return false;
      ed.setPosition(model.getPositionAt(off + 1));
      ed.focus();
      return true;
    },
    { path: p, tok: token, n: nth },
  );
  if (!ok) throw new Error(`placeCursor: "${token}" (#${nth}) not found in ${absPath}`);
}

/** Dismiss any visible toasts + peek so a row observes only what IT produced. */
export async function clearTransients(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.toast__close')) b.click();
  });
  await page.waitForTimeout(80);
}

/**
 * Run one navigation and wait for it to settle.
 *
 * @param {'f12'|'menu'} trigger  Both paths are covered across the matrix: F12 goes through the
 *   editor's own keybinding, `menu` through the app's ContextMenu → `runNavCommand`.
 * @param {string} [label] Context-menu row label (defaults to Go to Definition).
 */
export async function trigger(page, kind, label = 'Go to Definition') {
  const before = await observe(page);
  if (kind === 'f12') {
    await page.keyboard.press('F12');
  } else {
    const at = await page.evaluate(() => {
      const eds = window.monaco.editor.getEditors();
      const ed = eds[eds.length - 1];
      const pos = ed.getPosition();
      const vp = ed.getScrolledVisiblePosition(pos);
      const r = ed.getDomNode().getBoundingClientRect();
      window.__gotoPos = { lineNumber: pos.lineNumber, column: pos.column };
      return { x: r.left + vp.left + 2, y: r.top + vp.top + vp.height / 2 };
    });
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForSelector('.ctxmenu', { timeout: 8000 });
    // A real right-click also moves the caret, and the synthesized coordinate lands a pixel
    // or two off inside proportional glyphs — which would silently change WHICH symbol the
    // row is asking about. Restore the position the row chose; the menu dispatch (the thing
    // under test) is untouched.
    await page.evaluate(() => {
      const eds = window.monaco.editor.getEditors();
      const ed = eds[eds.length - 1];
      if (ed && window.__gotoPos) ed.setPosition(window.__gotoPos);
    });
    const item = page
      .locator('.ctxmenu__item')
      .filter({ has: page.getByText(label, { exact: true }) });
    await item.first().click();
  }
  const deadline = Date.now() + NAV_SETTLE_MS;
  let last = before;
  while (Date.now() < deadline) {
    await page.waitForTimeout(NAV_POLL_MS);
    last = await observe(page);
    if (changed(before, last) && !inFlight(last)) break;
  }
  // Then settle until the observation STOPS moving. A fixed pause was enough while every
  // target was already in the index; an on-demand resolution adds a host round trip, a file
  // read and a fresh CodeViewer mount after the tab strip has already changed — sampling in
  // that window sees the right tab with `editors: 0` and reads as a failure.
  return { before, after: await settle(page, Date.now() + NAV_QUIESCE_MS) };
}

/**
 * The wrapper's in-flight notice, which is a PROMISE of an outcome rather than one: it appears
 * the moment a host resolution starts and is replaced (or closed) when the navigation lands.
 * Sampling while it is up reads a nav that is still running as one that finished.
 */
const inFlight = (o) => /^Resolving /.test(o.overlay);

/** Poll until two consecutive observations agree AND an editor is mounted, or time runs out. */
async function settle(page, deadline) {
  let prev = await observe(page);
  for (;;) {
    await page.waitForTimeout(NAV_POLL_MS);
    const now = await observe(page);
    if (!inFlight(now) && now.editors > 0 && !changed(prev, now)) return now;
    if (Date.now() >= deadline) return now;
    prev = now;
  }
}

/** Read the context menu's navigation rows without running one (row 41). */
export async function readNavMenu(page) {
  const at = await page.evaluate(() => {
    const eds = window.monaco?.editor.getEditors() ?? [];
    const ed = eds[eds.length - 1];
    if (ed) {
      const vp = ed.getScrolledVisiblePosition(ed.getPosition() ?? { lineNumber: 1, column: 1 });
      const r = ed.getDomNode().getBoundingClientRect();
      return { x: r.left + vp.left + 2, y: r.top + vp.top + vp.height / 2, editor: true };
    }
    const host = document.querySelector('.center') ?? document.body;
    const r = host.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, editor: false };
  });
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const opened = await page
    .waitForSelector('.ctxmenu', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return { opened: false, rows: [] };
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ctxmenu__item')).map((el) => ({
      label: el.querySelector('span:not(.ctxmenu__icon):not(.ctxmenu__hint)')?.textContent ?? '',
      disabled: !!el.disabled,
    })),
  );
  await page.keyboard.press('Escape').catch(() => {});
  return { opened: true, rows };
}

// ──────────────────────────────────────────────────────────────────────────────
// Row bookkeeping / reporting
// ──────────────────────────────────────────────────────────────────────────────

export function createMatrix(name, log) {
  const rows = [];
  return {
    /**
     * Run one row. `fn` returns `{ pass, observed, note }` — or throws, which is recorded as a
     * failure with the message. Nothing here aborts the scenario.
     */
    async row(id, { flow, trigger: trig, current, target }, fn) {
      let entry;
      try {
        const r = await fn();
        entry = {
          id,
          flow,
          trigger: trig,
          current,
          target,
          status: r.inconclusive ? 'INCONCLUSIVE' : r.pass ? 'PASS' : 'FAIL',
          observed: r.observed ?? '',
        };
      } catch (e) {
        entry = {
          id,
          flow,
          trigger: trig,
          current,
          target,
          status: 'ERROR',
          observed: `harness: ${e?.message ?? e}`,
        };
      }
      rows.push(entry);
      log(`row ${id.padEnd(4)} ${entry.status.padEnd(12)} ${entry.observed}`);
      return entry;
    },
    rows,
    /** Print the table, then fail the scenario if any row failed. */
    finish() {
      const width = { id: 5, trig: 7, status: 12 };
      log('');
      log(`── ${name} — flow matrix ───────────────────────────────────────`);
      log(
        `${'ROW'.padEnd(width.id)}${'TRIG'.padEnd(width.trig)}${'RESULT'.padEnd(width.status)}SPEC(cur→tgt)  OBSERVED`,
      );
      for (const r of rows) {
        log(
          `${r.id.padEnd(width.id)}${r.trigger.padEnd(width.trig)}${r.status.padEnd(width.status)}${`${r.current}→${r.target}`.padEnd(15)}${r.observed}`,
        );
      }
      const bad = rows.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
      log(
        `── ${rows.length} rows · ${rows.filter((r) => r.status === 'PASS').length} pass · ${bad.length} fail/error · ${rows.filter((r) => r.status === 'INCONCLUSIVE').length} inconclusive`,
      );
      assert(bad.length === 0, `${bad.length} row(s) do not meet the spec's target behaviour`);
    },
  };
}

/** Did the navigation land in `pathSuffix` with `marker` on the cursor's line? */
export function landed(after, pathSuffix, marker) {
  const p = (after.path ?? '').toLowerCase();
  return p.endsWith(pathSuffix.toLowerCase()) && after.lineText.includes(marker);
}

/** One-line rendering of what a row saw, for the evidence table. */
export function describe(after) {
  const bits = [`at ${short(after.path)}:${after.line} «${clip(after.lineText, 44)}»`];
  if (after.peek) bits.push('peek');
  if (after.overlay) bits.push(`msg«${clip(after.overlay, 60)}»`);
  if (after.toasts.length) bits.push(`toast«${clip(after.toasts.join(' / '), 70)}»`);
  return bits.join(' ');
}

function short(p) {
  if (!p) return '(none)';
  const parts = p.split('/');
  return parts.slice(-3).join('/');
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
