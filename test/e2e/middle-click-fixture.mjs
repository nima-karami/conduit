/**
 * Shared fixture + read helpers for the middle-click scenarios
 * (docs/specs/2026-09-22-middle-click-new-tab.md §7). NOT a scenario — the runner only picks up
 * `*.e2e.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openSession, REPO, spyMain } from './harness.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function writeAll(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/**
 * A git repo holding `files` as its first commit, then one commit per `commits` entry, then the
 * uncommitted `dirty` writes. Returns the root with `/` separators.
 */
export function writeFixtureRepo({ files, commits = [], dirty = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'conduit-middle-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'e2e@conduit.test');
  git(root, 'config', 'user.name', 'e2e');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeAll(root, files);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  commits.forEach((c, i) => {
    writeAll(root, c);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', `change ${i + 1}`);
  });
  writeAll(root, dirty);
  return root.replace(/\\/g, '/');
}

/**
 * Everything a background open must leave alone (spec §7 "unchanged"). Compare two snapshots
 * with `sameSnapshot`.
 */
export function snapshotUnchanged(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const describe = (el) =>
      el
        ? `${el.tagName}.${String(el.className).split(' ')[0]}#${el.getAttribute('data-path') ?? el.getAttribute('data-tabid') ?? ''}`
        : 'none';
    return {
      activeTitle:
        document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent ?? null,
      activeEl: describe(a),
      centerView: document.querySelector('.board, .arch') ? 'other' : 'editor',
      selection: Array.from(document.querySelectorAll('.filerow--selected'))
        .map((r) => r.getAttribute('data-path'))
        .join('|'),
      scrollY: window.scrollY,
      scrollTops: Array.from(
        document.querySelectorAll('.tabbar, .rightpane__scroll--files, .search__results, .review'),
      )
        .map((el) => `${el.scrollTop},${el.scrollLeft}`)
        .join('|'),
    };
  });
}

export function sameSnapshot(a, b) {
  const diffs = Object.keys(a).filter((k) => a[k] !== b[k]);
  return diffs.length === 0
    ? null
    : diffs.map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`).join('; ');
}

export function tabInfo(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar [role="tab"]')).map((el) => ({
      title: el.querySelector('span')?.textContent ?? '',
      active: el.classList.contains('tab--active'),
      preview: el.classList.contains('tab--preview'),
      flash: el.classList.contains('tab--flash'),
    })),
  );
}

/** The dedicated background-open status region (not the nav/timer one). */
export function statusText(page) {
  return page.evaluate(() => document.querySelector('.bg-open-status')?.textContent ?? null);
}

/** Records every write to the status region into `window.__statusLog` (AC-14). */
export function watchStatus(page) {
  return page.evaluate(() => {
    window.__statusLog = [];
    const el = document.querySelector('.bg-open-status');
    if (!el) throw new Error('no .bg-open-status region');
    new MutationObserver(() => window.__statusLog.push(el.textContent ?? '')).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

/** Resolves when a tab titled `title` exists; returns its info. Throws on timeout. */
export async function waitTab(page, title, timeout = 10000) {
  await page.waitForFunction(
    (t) =>
      Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
        (el) => el.querySelector('span')?.textContent === t,
      ),
    title,
    { timeout },
  );
  return (await tabInfo(page)).find((t) => t.title === title);
}

/**
 * A real-hand middle click: down, a few px of jitter, up on the same element. The jitter is what
 * lets Windows autoscroll engage in a scrollable container and swallow the `auxclick` (spec C2);
 * Playwright's `click({button:'middle'})` never moves, so it can't catch that defect.
 */
export async function middleClickJitter(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('middleClickJitter: element has no box');
  const x = box.x + Math.min(box.width / 2, 40);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x + 3, y + 2, { steps: 3 });
  await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.up({ button: 'middle' });
}

/** Resolves when the status region reads `text` exactly. Throws on timeout. */
export function waitStatus(page, text, timeout = 5000) {
  return page.waitForFunction(
    (t) => document.querySelector('.bg-open-status')?.textContent === t,
    text,
    { timeout },
  );
}

/** A titled fixture page with no default margins, so guest coordinates map to its layout. */
export const htmlPage = (title, body = '', style = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>html,body{margin:0;padding:0}${style}</style></head><body>${body}</body></html>`;

/** Sends a real down/up click at (x, y) to the guest showing `url`, from the main process, so it
 *  reaches the host's `input-event` gesture record. False when no such guest exists. */
export function clickGuest(app, url, button, x, y, modifiers = []) {
  return app.evaluate(
    ({ webContents }, a) => {
      const g = webContents
        .getAllWebContents()
        .find((w) => w.getType() === 'webview' && w.getURL() === a.url);
      if (!g) return false;
      const at = { x: a.x, y: a.y, modifiers: a.modifiers };
      g.sendInputEvent({ type: 'mouseMove', ...at });
      g.sendInputEvent({ type: 'mouseDown', button: a.button, clickCount: 1, ...at });
      g.sendInputEvent({ type: 'mouseUp', button: a.button, clickCount: 1, ...at });
      return true;
    },
    { url, button, x, y, modifiers },
  );
}

/** Runs `js` in the guest showing `url` WITH page-side user activation — which must never reach
 *  the host's gesture record. False when no such guest exists. */
export function guestScript(app, url, js) {
  return app.evaluate(
    async ({ webContents }, a) => {
      const g = webContents
        .getAllWebContents()
        .find((w) => w.getType() === 'webview' && w.getURL() === a.url);
      if (!g) return false;
      await g.executeJavaScript(a.js, true);
      return true;
    },
    { url, js },
  );
}

/** A shell session on the repo, an `openExternal` spy, and `url` open as the active web tab. */
export async function startWebFixture(app, page, url, title) {
  await openSession(page, { path: REPO.replace(/\\/g, '/'), agentId: 'shell:cmd' });
  await spyMain(app, [{ api: 'openExternal' }]);
  await openWebTab(app, page, url, title);
}

/** Polls `fn` until it returns a truthy value (returned) or `timeout` ms pass (null). */
export async function poll(fn, timeout, interval = 150) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Every `<webview>` guest's URL and loading state, read in the main process. */
export function guestState(app) {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getType() === 'webview')
      .map((w) => ({ url: w.getURL(), loading: w.isLoading() })),
  );
}

/** Serves `pages` (path → html) on a loopback port. Returns the server and its origin. */
export async function serveHtml(pages) {
  const server = createServer((req, res) => {
    const body = pages[req.url ?? ''];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Opens `url` as a web tab through the palette's "Open web page" and waits until its guest has
 * loaded and the tab is active under the page's `title`.
 */
export async function openWebTab(app, page, url, title) {
  await page.click('.omnibar');
  await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
  await page.fill('.palette__input', '>open web page');
  await page.waitForSelector('.palette__title', { timeout: 8000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal__input', { state: 'visible', timeout: 8000 });
  await page.fill('.modal__input', url);
  await page.keyboard.press('Enter');
  const loaded = await poll(
    async () => (await guestState(app)).some((g) => g.url === url && !g.loading),
    15000,
  );
  if (!loaded)
    throw new Error(`guest never loaded ${url}: ${JSON.stringify(await guestState(app))}`);
  const titled = await poll(
    async () => (await tabInfo(page)).some((t) => t.title === title && t.active),
    10000,
  );
  if (!titled)
    throw new Error(`web tab never adopted "${title}": ${JSON.stringify(await tabInfo(page))}`);
}
