/**
 * split-editor-surfaces — split-editor scenarios that need their own profile or a special surface
 * (docs/specs/2026-09-28-split-editor.md §7). One launch, with `autoSave: 'onFocusChange'` seeded:
 *   P9  leaving b.ts in the right group saves it (viewLeave), while the left group still shows it
 *       clean.
 *   E10 a web tab moved to the other group keeps its page: a marker set in the guest survives and
 *       the page is not fetched again (D9).
 *   WF  a click inside the right group's guest activates the right group (Decisions Needed #4).
 *   D8  one PDF in both groups: closing the right tab leaves the left rendering, and a second PDF
 *       still loads (the shared pdf.js worker survives).
 */

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, REPO } from './harness.mjs';
import {
  explorer,
  G,
  openFromExplorer,
  shownTab,
  sleep,
  tabOf,
  waitShown,
} from './split-editor-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[split-editor-surfaces] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('split-editor-surfaces');

const repo = mkdtempSync(join(tmpdir(), 'conduit-split-surf-'));
writeFileSync(join(repo, 'a.ts'), 'export const answer = 42;\n');
writeFileSync(join(repo, 'b.ts'), "import { answer } from './a';\nexport const b = answer;\n");
const samplePdf = join(REPO, 'test', 'e2e', 'fixtures', 'sample.pdf');
copyFileSync(samplePdf, join(repo, 'one.pdf'));
copyFileSync(samplePdf, join(repo, 'two.pdf'));
const repoArg = repo.replace(/\\/g, '/');

const WEB_TITLE = 'Split Web Fixture';

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-split-surf-ud-'));
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { autoSave: 'onFocusChange' } }),
);

const webFrame = (g) => `.editorgroups > .webhost[data-group="${g}"]:not([hidden]) .webview__frame`;

/** Runs `js` in the guest of the web tab shown in group g, through the <webview>'s own API. */
const inGuest = (page, g, js) =>
  page.evaluate(({ sel, src }) => document.querySelector(sel)?.executeJavaScript(src) ?? null, {
    sel: webFrame(g),
    src: js,
  });

/** E10: a web tab moved to the other group keeps its page (no reload). */
async function phaseWebMove(page, server) {
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.waitForSelector(`${G(1)}[data-active="true"]`, { timeout: 5000 });
  await page.click('.omnibar');
  await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
  await page.fill('.palette__input', '>open web page');
  await page.waitForSelector('.palette__title', { timeout: 8000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal__input', { state: 'visible', timeout: 8000 });
  await page.fill('.modal__input', server.url);
  await page.keyboard.press('Enter');
  await waitShown(page, 1, WEB_TITLE, 'E10');
  const set = await inGuest(page, 1, 'window.__marker = 1');
  assert(set === 1, `E10: could not set the guest marker (${set})`);
  const loads = server.hits();
  await tabOf(page, 1, WEB_TITLE).click({ button: 'right' });
  const item = page.locator('.ctxmenu__item', { hasText: /^Move to Other Group$/ });
  await item
    .waitFor({ timeout: 5000 })
    .catch(() => assert(false, 'E10: no Move to Other Group item'));
  await item.click();
  await waitShown(page, 2, WEB_TITLE, 'E10');
  await page
    .waitForSelector(webFrame(2), { state: 'attached', timeout: 5000 })
    .catch(() => assert(false, 'E10: no visible web host in the right group'));
  await sleep(1000);
  const marker = await inGuest(page, 2, 'window.__marker');
  log('E10: marker after the move', marker, '· page loads', loads, '→', server.hits());
  assert(marker === 1, `E10: the guest reloaded on the move (marker ${marker})`);
  assert(server.hits() === loads, `E10: the page was fetched again (${loads} → ${server.hits()})`);
  log('E10 ✓ the web tab moved without a reload');
}

/** Web focus (Decisions Needed #4): a click inside the right group's guest activates that group. */
async function phaseWebFocus(page) {
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.waitForSelector(`${G(1)}[data-active="true"]`, { timeout: 5000 });
  const box = await page.locator(webFrame(2)).boundingBox();
  assert(box, 'WF: the right group has no visible web frame');
  await inGuest(
    page,
    2,
    "window.__downs = 0; addEventListener('mousedown', () => { window.__downs += 1; }); 0",
  );
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const reached = await page
    .waitForSelector(`${G(2)}[data-active="true"]`, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  const guest = await inGuest(page, 2, '({ downs: window.__downs, focused: document.hasFocus() })');
  log('WF: guest after the click', JSON.stringify(guest), '· right group active:', reached);
  assert(guest?.downs === 1, `WF: the click never reached the guest (${JSON.stringify(guest)})`);
  assert(reached, 'WF: clicking inside the guest did not activate the right group');
  log('WF ✓ a click inside the guest activates its group');
}

const pdfRendered = (page, g) =>
  page.evaluate((sel) => {
    const view = document.querySelector(`${sel} .pdfview`);
    const canvas = view?.querySelector('.pdfview__canvas');
    return {
      canvas: canvas ? canvas.width * canvas.height : 0,
      corrupt: (view?.textContent ?? '').includes('corrupt or invalid PDF'),
    };
  }, G(g));

async function waitPdf(page, g, label) {
  await page
    .waitForFunction(
      (sel) => {
        const c = document.querySelector(`${sel} .pdfview .pdfview__canvas`);
        return !!c && c.width > 0 && c.height > 0;
      },
      G(g),
      { timeout: 20000 },
    )
    .catch(async () =>
      assert(
        false,
        `${label}: group ${g}'s PDF did not render ${JSON.stringify(await pdfRendered(page, g))}`,
      ),
    );
}

/** D8: one PDF in both groups; closing one tab leaves the other rendering, and a fresh PDF loads. */
async function phasePdf(page) {
  await page.locator(`${G(1)} .monaco-editor`).click();
  await explorer(page, 'one.pdf', 'dblclick');
  await waitShown(page, 1, 'one.pdf', 'D8');
  await waitPdf(page, 1, 'D8');
  await page.locator(`${G(1)} .pdfview`).click();
  await page.keyboard.press('Control+Backslash');
  await waitShown(page, 2, 'one.pdf', 'D8');
  await waitPdf(page, 2, 'D8');
  await tabOf(page, 2, 'one.pdf').click({ button: 'middle' });
  await page
    .waitForFunction(
      (sel) =>
        ![...document.querySelectorAll(`${sel} [role="tab"] span`)].some(
          (e) => e.textContent === 'one.pdf',
        ),
      G(2),
      { timeout: 5000 },
    )
    .catch(() => assert(false, 'D8: the right group’s PDF tab did not close'));
  await sleep(500);
  const left = await pdfRendered(page, 1);
  assert(
    left.canvas > 0 && !left.corrupt,
    `D8: the left PDF stopped rendering ${JSON.stringify(left)}`,
  );
  await tabOf(page, 1, 'one.pdf').click();
  await explorer(page, 'two.pdf', 'dblclick');
  await waitShown(page, 1, 'two.pdf', 'D8');
  await waitPdf(page, 1, 'D8 (a second PDF)');
  const second = await pdfRendered(page, 1);
  assert(!second.corrupt, 'D8: the second PDF reports "corrupt or invalid PDF"');
  log('D8 ✓ a PDF in both groups survives one tab closing, and a fresh PDF still loads');
}

async function phaseViewLeave(page) {
  await openFromExplorer(page, 'b.ts');
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.keyboard.press('Control+Backslash');
  await waitShown(page, 2, 'b.ts', 'P9');
  await explorer(page, 'a.ts', 'dblclick');
  await waitShown(page, 2, 'a.ts', 'P9');
  await tabOf(page, 2, 'b.ts').click();
  await waitShown(page, 2, 'b.ts', 'P9');
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// p9');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 2, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'P9: both b.ts tabs should be dirty'));
  await tabOf(page, 2, 'a.ts').click();
  await waitShown(page, 2, 'a.ts', 'P9');
  const saved = () => readFileSync(join(repo, 'b.ts'), 'utf8').includes('// p9');
  const deadline = Date.now() + 8000;
  while (!saved() && Date.now() < deadline) await sleep(200);
  assert(saved(), 'P9: b.ts was not saved when the right group left it');
  assert((await shownTab(page, 1)) === 'b.ts', 'P9: the left group no longer shows b.ts');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 0, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'P9: b.ts is still dirty after the save'));
  log('P9 ✓ leaving the file in one group saves it; the other group shows it clean');
}

let hits = 0;
const httpServer = createServer((_req, res) => {
  hits += 1;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${WEB_TITLE}</title><body><h1>web</h1></body>`);
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const server = { url: `http://127.0.0.1:${httpServer.address().port}/`, hits: () => hits };

let launched = null;
let code = 0;
try {
  launched = await launchApp({ userDataDir });
  const { page } = launched;
  await openSession(page, { path: repoArg });
  await phaseViewLeave(page);
  await phaseWebMove(page, server);
  await phaseWebFocus(page);
  await phasePdf(page);
  log('PASS ✓ split-editor-surfaces: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[split-editor-surfaces] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[split-editor-surfaces] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
httpServer.close();
process.exit(code);
