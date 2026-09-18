/**
 * html-viewer — an .html file renders as a page, and toggles back to source.
 *
 * The user-facing half of the html-preview work. `preview-transport.e2e.mjs` proves the
 * scheme carries bytes and enforces its origin boundary; this proves the VIEWER: that
 * opening an .html file from the Explorer lands you on the rendered page with its own CSS
 * and JS applied, that the source toggle round-trips, and that the states that are supposed
 * to protect you actually render.
 *
 * Page assertions go THROUGH THE MAIN PROCESS into the guest
 * (`webContents.getAllWebContents()` -> `executeJavaScript`). Asserting from the host DOM
 * would pass against a guest that rendered nothing — which is the exact failure this whole
 * run exists to catch.
 *
 * Windows-only, matching the suite.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[html-viewer] SKIP — suite is Windows-only');
  process.exit(0);
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Agent Report</title>
<link rel="stylesheet" href="./assets/style.css"></head>
<body><h1 id="h">Quarterly agent report</h1>
<script src="./assets/app.js"></script>
<script>
window.__net = 'pending';
fetch('https://cdn.example.invalid/chart.js')
  .then(() => { window.__net = 'REACHED'; })
  .catch(() => { window.__net = 'blocked'; });
</script>
</body></html>
`;

/** Read the guest's own DOM through the main process. */
const inGuest = (app, expr) =>
  app.evaluate(async ({ webContents }, src) => {
    const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
    if (!guest) return { error: 'no guest webContents' };
    try {
      return await guest.executeJavaScript(src);
    } catch (e) {
      return { error: String(e) };
    }
  }, expr);

runScenario('html-viewer', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-hv-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'style.css'), '#h{color:rgb(9,8,7)}\n');
  writeFileSync(join(root, 'assets', 'app.js'), "document.body.dataset.ran='yes';\n");
  writeFileSync(join(root, 'report.html'), PAGE);
  writeFileSync(join(root, 'blank.html'), '   \n  \n');
  writeFileSync(join(root, 'notes.md'), '# not html\n');

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  const row = (name) => page.locator('.filerow', { hasText: name }).first();

  // ── An .html file opens RENDERED, not in the editor ──────────────────────
  await row('report.html').click();
  await page.waitForSelector('.htmlview__frame', { state: 'attached', timeout: 20000 });
  const src = await page.getAttribute('.htmlview__frame', 'src');
  assert(
    src?.startsWith('conduit-preview://'),
    `guest src must be a conduit-preview URL, got ${src}`,
  );
  assert(!src.includes(root.replace(/\\/g, '/')), `URL must not leak the absolute path: ${src}`);
  log('opening an .html file mounts the preview guest, token-shaped src ✓');

  assert(
    (await page.locator('.docpanel.docpage').count()) > 0,
    'a rendered HTML tab takes the .docpage document treatment, as Markdown does',
  );
  log('.docpage document treatment applied (it was absent before this work) ✓');

  await page.waitForTimeout(5000);
  const probe = await inGuest(
    app,
    `({
       title: document.title,
       heading: document.querySelector('#h') ? document.querySelector('#h').textContent : null,
       color: document.querySelector('#h') ? getComputedStyle(document.querySelector('#h')).color : null,
       ran: document.body.dataset.ran || null,
       net: window.__net || null,
     })`,
  );
  log(`guest probe: ${JSON.stringify(probe)}`);
  assert(!probe.error, `guest must be reachable: ${probe.error}`);
  assert(probe.title === 'Agent Report', `page loaded, got title ${probe.title}`);
  assert(probe.heading === 'Quarterly agent report', `body rendered, got ${probe.heading}`);
  assert(probe.color === 'rgb(9, 8, 7)', `relative ./assets/style.css applied, got ${probe.color}`);
  assert(probe.ran === 'yes', `relative ./assets/app.js ran, got ${probe.ran}`);
  log('the page renders with its own CSS and JS — measured inside the guest ✓');

  // ── The network is blocked, and the user is told by whom ─────────────────
  assert(probe.net === 'blocked', `a remote resource load must be cancelled, got ${probe.net}`);
  await page.waitForSelector('.htmlview__bar', { timeout: 10000 });
  const barText = await page.locator('.htmlview__bar-text').first().textContent();
  assert(
    /cdn\.example\.invalid/.test(barText ?? ''),
    `the allow bar must name the host it blocked, got "${barText}"`,
  );
  assert(
    (await page.locator('.htmlview__bar button', { hasText: 'Allow' }).count()) > 0,
    'the allow bar offers Allow',
  );
  log(`remote load blocked and surfaced: "${barText?.trim()}" ✓`);

  // ── Source toggle round-trips ────────────────────────────────────────────
  await page.locator('.viewer__toggle', { hasText: 'View source' }).first().click();
  await page.waitForSelector('.docpanel .monaco-editor', { timeout: 20000 });
  assert(
    (await page.locator('.htmlview__frame').count()) === 0,
    'the guest is gone in source view',
  );
  assert(
    (await page.locator('.viewer__toggle', { hasText: 'View rendered' }).count()) > 0,
    'source view offers View rendered',
  );
  log('View source shows the HTML in Monaco ✓');

  await page.locator('.viewer__toggle', { hasText: 'View rendered' }).first().click();
  await page.waitForSelector('.htmlview__frame', { state: 'attached', timeout: 20000 });
  log('View rendered brings the page back ✓');

  // ── A non-HTML file is untouched by any of this ──────────────────────────
  await row('notes.md').click();
  await page.waitForTimeout(1500);
  assert(
    (await page.locator('.htmlview__frame').count()) === 0,
    'a markdown file must not mount a preview guest',
  );
  log('a .md file still renders as Markdown, no preview guest ✓');

  // ── An empty .html says so rather than showing a blank pane ──────────────
  await row('blank.html').click();
  await page.waitForTimeout(2500);
  const emptyShown = await page.locator('.docpanel', { hasText: 'This file is empty.' }).count();
  assert(emptyShown > 0, 'an empty .html renders the empty-document state, not a blank pane');
  assert(
    (await page.locator('.htmlview__frame').count()) === 0,
    'an empty document never creates a guest',
  );
  log('empty document state renders, and no guest is created for it ✓');

  log('PASS — renders with its own assets, blocks the network and says so, toggles to source');
});
