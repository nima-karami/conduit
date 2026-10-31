/**
 * Shared fixtures for the conduit-mcp-app-* scenarios (plan 2026-10-30-conduit-mcp-app-control
 * T3.1). NOT a scenario — the runner only picks up `*.e2e.mjs`. The fake-agent driver itself is
 * `conduit-mcp-helpers.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { until } from './conduit-mcp-helpers.mjs';
import { assert } from './harness.mjs';
import { openPalette, paletteRow } from './middle-click-surfaces-helpers.mjs';

const git = (dir, args, input) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', ...(input ? { input } : {}) }).trim();

/**
 * git init + one `git fast-import` stream: `commits` linear commits on main (message `c<n>`, each
 * rewriting `f.txt`), branch `feature` at c<n-1>, lightweight tag `v1` at c1, then a checkout.
 * One process instead of a commit loop: hundreds of `git commit` spawns would dominate the
 * scenario on the Windows runner (plan T3.1 Scripts).
 * @returns {{ dir: string, shas: string[] }} shas[0] = c1
 */
export function gitFixture(dir, { commits }) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'e2e@conduit.test']);
  git(dir, ['config', 'user.name', 'e2e']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  const data = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  let stream = '';
  for (let n = 1; n <= commits; n++) {
    stream +=
      `commit refs/heads/main\nmark :${n}\n` +
      `committer e2e <e2e@conduit.test> ${1_700_000_000 + n * 60} +0000\n` +
      data(`c${n}`) +
      `M 644 inline f.txt\n${data(`content ${n}`)}`;
  }
  stream += `reset refs/heads/feature\nfrom :${commits - 1}\n\n`;
  stream += 'reset refs/tags/v1\nfrom :1\n\n';
  git(dir, ['fast-import', '--quiet'], stream);
  git(dir, ['reset', '--hard', '-q', 'main']);
  const shas = git(dir, ['rev-list', '--reverse', 'main']).split('\n');
  assert(shas.length === commits, `gitFixture made ${shas.length} commits, not ${commits}`);
  return { dir, shas };
}

/** A loopback http server answering 200 "<title>ok</title>". @returns {Promise<{url: string, close: () => Promise<void>}>} */
export async function httpFixture() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>ok</title><p>ok</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The session's display name from the latest host state (needs `tapBridge`). */
const nameOf = (page, sessionId) =>
  page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.name ?? null,
    sessionId,
  );

/**
 * Split the session `partnerId` beside the active one through the palette ("Split with: <name>"),
 * and wait for its split bar. The bar is attached even while a doc tab hides the terminal stack.
 */
export async function splitWith(page, partnerId) {
  const name = await nameOf(page, partnerId);
  assert(name, `splitWith: no session ${partnerId}`);
  await openPalette(page, `>Split with: ${name}`);
  await paletteRow(page, `Split with: ${name}`).click();
  await page
    .locator('.termhost__bar .termhost__name', { hasText: name })
    .waitFor({ state: 'attached', timeout: 10_000 });
}

/** The split partner's name from its bar, or null when nothing is split. */
export const splitName = (page) =>
  page.evaluate(
    () => document.querySelector('.termhost__bar .termhost__name')?.textContent ?? null,
  );

/** The shown session's doc tabs as `data-tabid`s (`file:<path>`, `web:<url>`, `review:@review`…). */
export const shownTabs = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar [role="tab"]'), (t) =>
      t.getAttribute('data-tabid'),
    ),
  );

/** The shown session's active doc tab id, or null when the terminal tab is active. */
export const activeTab = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector('.tabbar [role="tab"][aria-selected="true"]')
        ?.getAttribute('data-tabid') ?? null,
  );

/** Forward-slashed and lower-cased, for comparing a host path with a fixture path on Windows. */
const slashed = (p) => p.replaceAll('\\', '/').toLowerCase();

/**
 * True when a tab id or a result path names the fixture file `abs`, compared on its last two
 * segments: the runner's temp root can come back as an 8.3 short name on one side only.
 */
export const namesFile = (idOrPath, abs) =>
  slashed(idOrPath).endsWith(`/${slashed(abs).split('/').slice(-2).join('/')}`);

/**
 * Put the keyboard where a user typing would have it in the shown session: its terminal (the
 * Terminal tab activated first) or its active file's editor.
 * @param {'terminal' | 'editor'} where
 */
export async function parkKeyboard(page, where) {
  if (where === 'terminal') {
    await page.locator('.tab[data-tabid="__terminal__"]').first().click();
    await page.locator('.termhost:visible .xterm-helper-textarea').first().focus();
  } else {
    await page.locator('.viewer__monaco .monaco-editor').first().click();
  }
  const sel = where === 'terminal' ? '.xterm' : '.monaco-editor';
  assert(
    await page.evaluate((s) => !!document.activeElement?.closest(s), sel),
    `the keyboard never reached the ${where}`,
  );
}

/** What holds DOM focus, for a failure message. */
export const focusedNow = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}.${el.className}` : 'null';
  });

/**
 * After a tool-driven open hid the focused element, wait for focus to land inside `sel` (never
 * the web guest itself) and for the polite announcement `said` (spec
 * 2026-10-30-conduit-mcp-app-control §2.1, A4).
 */
export async function assertLanded(page, sel, said, what) {
  const landed = () =>
    page.evaluate(
      (s) => !!document.activeElement?.closest(s) && document.activeElement?.tagName !== 'WEBVIEW',
      sel,
    );
  assert(
    await until(landed, 5_000),
    `${what}: focus is on ${await focusedNow(page)}, not in ${sel}`,
  );
  const heard = () =>
    page.evaluate(
      (t) =>
        Array.from(document.querySelectorAll('[role="status"]')).some((r) =>
          r.textContent?.includes(t),
        ),
      said,
    );
  assert(await until(heard, 5_000), `${what}: nothing announced "${said}"`);
}
