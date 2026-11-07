/**
 * os-drag-out (docs/specs/archive/2026-09-24-os-drag-out.md): the DownloadURL drag-out and its
 * host gate, Copy → OS clipboard request, and the dead-space navigation guard. S0 chose outcome B
 * (docs/runs/2026-09-24-os-drag-out/s0-spike.md), so there are no native startDrag cases.
 *
 * Under CONDUIT_E2E the host never writes the real clipboard: it records the payload in
 * globalThis.__conduitClipboardLog instead (electron/drag-out-host.ts). Playwright cannot perform
 * the OS drop that makes Chromium request a drag-download, so the allowed case goes through
 * __conduitAllowDownload, the decision will-download itself calls; the refused case is a real
 * page-side download, which will-download must cancel.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  closeApp,
  openSession,
  runScenario,
  showRightView,
  tapBridge,
} from './harness.mjs';

// Mirrors OS_FILE_CLIPBOARD.win32 in src/drag-out-policy.ts (S0 F4: PASS); flip both together.
const WIN32_OS_CLIPBOARD = true;

const project = mkdtempSync(join(tmpdir(), 'conduit-dragout-'));
const NAME = 'ünï 日本.txt';
// The session opens with forward slashes (harness openSession) and rows join with '/'; the host
// hands PowerShell the resolved native form, so that is what stdin must carry.
const file = win32.resolve(project, NAME);
writeFileSync(file, 'bytes');
const other = win32.resolve(project, 'other.txt');
writeFileSync(other, 'not dragged');
mkdirSync(win32.resolve(project, 'docs'));

/**
 * Resolves true once the host probe `log` holds at least `min` entries of `kind` (any kind when
 * null), false at the deadline. Polled in the main process: the entries are written there by IPC
 * and will-download handlers the page cannot observe.
 */
const waitLogCount = (app, { log, kind = null, min, timeout }) =>
  app.evaluate(
    (_e, a) =>
      new Promise((resolve) => {
        const deadline = Date.now() + a.timeout;
        const tick = () => {
          const entries = globalThis[a.log] ?? [];
          const n = a.kind ? entries.filter((e) => e.kind === a.kind).length : entries.length;
          if (n >= a.min) return resolve(true);
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(tick, 5);
        };
        tick();
      }),
    { log, kind, min, timeout },
  );
const DOWNLOAD_LOG = '__conduitDownloadLog';
const downloadLog = (app) => app.evaluate(() => globalThis.__conduitDownloadLog);
/** The app window's webContents id, and a real download it starts (not a drag). */
const appContentsId = (app) =>
  app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
        ?.webContents.id,
  );
const pageDownload = (app, url) =>
  app.evaluate(({ BrowserWindow }, u) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('index.html'))
      ?.webContents.downloadURL(u);
  }, url);
const dragStartOn = (locator) =>
  locator.evaluate((el) => {
    const dt = new DataTransfer();
    const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
    el.dispatchEvent(ev);
    return { downloadUrl: dt.getData('DownloadURL'), prevented: ev.defaultPrevented };
  });

/** Bounded negative: the page URL must not leave `url` during the window. */
async function assertUrlHeldFor(page, ms, url) {
  try {
    await page.waitForFunction((u) => location.href !== u, url, { timeout: ms });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    return;
  }
  assert(false, `the page navigated away from ${url}`);
}

await runScenario('os-drag-out', async ({ app, page, log }) => {
  await openSession(page, { path: project });
  await tapBridge(page);
  await showRightView(page, 'files');

  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: NAME }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 10_000 });
  await row.first().click();
  await page.keyboard.press('Control+C');
  if (WIN32_OS_CLIPBOARD) {
    assert(
      await waitLogCount(app, { log: '__conduitClipboardLog', min: 1, timeout: 10_000 }),
      'Ctrl+C recorded an OS clipboard request',
    );
  } else {
    // Nothing may be recorded: a bounded negative window.
    assert(
      !(await waitLogCount(app, { log: '__conduitClipboardLog', min: 1, timeout: 500 })),
      'unsupported: nothing recorded',
    );
  }

  const clip = await app.evaluate(() => globalThis.__conduitClipboardLog);
  assert(Array.isArray(clip), '__conduitClipboardLog is installed under CONDUIT_E2E');
  const toasts = await page.locator('.toast--error').count();
  if (WIN32_OS_CLIPBOARD) {
    const last = clip.at(-1);
    assert(last?.payload?.kind === 'powershell', `powershell payload, got ${JSON.stringify(last)}`);
    assert(
      JSON.stringify(last.stdinPaths) === JSON.stringify([file]),
      `stdin carries exactly the copied path, got ${JSON.stringify(last.stdinPaths)}`,
    );
    assert(toasts === 0, 'a recorded copy raises no error toast');
    log('Ctrl+C → PowerShell payload with the non-ASCII path on stdin ✓');
  } else {
    assert(clip.length === 0, `unsupported: nothing recorded, got ${JSON.stringify(clip)}`);
    assert(toasts === 0, 'unsupported is silent (AC9)');
    log('Ctrl+C → win32 OS clipboard unsupported, silent ✓');
  }

  // ── DownloadURL drag-out and the will-download gate ──────────────────────────────────────
  const fileUrl = pathToFileURL(file).href;
  const otherUrl = pathToFileURL(other).href;
  const cid = await appContentsId(app);
  assert(typeof cid === 'number', 'found the app window');
  const log0 = await downloadLog(app);
  assert(Array.isArray(log0), '__conduitDownloadLog is installed under CONDUIT_E2E');

  await pageDownload(app, fileUrl);
  assert(
    await waitLogCount(app, { log: DOWNLOAD_LOG, kind: 'download', min: 1, timeout: 10_000 }),
    'the page-initiated download reached will-download',
  );
  const pageInitiated = (await downloadLog(app)).filter((e) => e.kind === 'download');
  assert(
    pageInitiated.length === 1 &&
      !pageInitiated[0].allowed &&
      pageInitiated[0].url.includes('.txt'),
    `a page-initiated file download with nothing armed is refused: ${JSON.stringify(pageInitiated)}`,
  );
  log('page-initiated file: download refused by will-download ✓');

  const dragged = await dragStartOn(row.first());
  assert(!dragged.prevented, 'the HTML5 drag is kept (internal drops still work)');
  assert(
    dragged.downloadUrl.startsWith(`application/octet-stream:${NAME}:file:///`) &&
      dragged.downloadUrl.endsWith(encodeURIComponent(NAME)),
    `file row stamps DownloadURL, got "${dragged.downloadUrl}"`,
  );
  assert(
    await waitLogCount(app, { log: DOWNLOAD_LOG, kind: 'arm', min: 1, timeout: 10_000 }),
    'dragstart reached the host',
  );
  const armedEntry = (await downloadLog(app)).filter((e) => e.kind === 'arm').at(-1);
  assert(
    armedEntry?.accepted === true && armedEntry.path === file,
    `dragstart armed the host with the validated path: ${JSON.stringify(armedEntry)}`,
  );
  log('file row dragstart → DownloadURL + host grant ✓');

  const allow = (url) =>
    app.evaluate((_e, a) => globalThis.__conduitAllowDownload(a.url, a.cid), { url, cid });
  assert((await allow(otherUrl)) === false, 'another file than the armed one is refused');
  // allow() above records a 'download' entry too, so wait for one beyond the current count.
  const downloadsBefore = (await downloadLog(app)).filter((e) => e.kind === 'download').length;
  await pageDownload(app, otherUrl);
  assert(
    await waitLogCount(app, {
      log: DOWNLOAD_LOG,
      kind: 'download',
      min: downloadsBefore + 1,
      timeout: 10_000,
    }),
    'the second page-initiated download reached will-download',
  );
  const otherReal = (await downloadLog(app)).filter((e) => e.kind === 'download').at(-1);
  assert(
    otherReal && !otherReal.allowed && otherReal.url.includes('other.txt'),
    `a real download of another file is refused while a grant is live: ${JSON.stringify(otherReal)}`,
  );
  assert((await allow(fileUrl)) === true, 'the armed file is admitted once');
  assert((await allow(fileUrl)) === false, 'the grant is single-use');
  log('gate: other path refused, armed file admitted once ✓');

  const armsBefore = (await downloadLog(app)).filter((e) => e.kind === 'arm').length;
  const folderRow = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^docs$/ }),
  });
  const folderDrag = await dragStartOn(folderRow.first());
  // Bounded negative: a folder drag must not arm.
  await waitLogCount(app, { log: DOWNLOAD_LOG, kind: 'arm', min: armsBefore + 1, timeout: 300 });
  assert(
    folderDrag.downloadUrl === '',
    `a folder drag carries no DownloadURL: "${folderDrag.downloadUrl}"`,
  );
  assert(
    (await downloadLog(app)).filter((e) => e.kind === 'arm').length === armsBefore,
    'a folder drag arms nothing',
  );
  log('folder row: no DownloadURL, nothing armed ✓');

  const before = page.url();
  await page.evaluate(() => {
    location.href = 'file:///C:/Windows/win.ini';
  });
  await assertUrlHeldFor(page, 500, before);
  assert(
    before.includes('index.html') && page.url() === before,
    `still the app shell: ${page.url()}`,
  );
  log('file: navigation blocked ✓');

  const over = await page.evaluate(() => {
    const target = document.querySelector('.centerpane');
    if (!target) return null;
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.txt'));
    dt.dropEffect = 'copy';
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(ev);
    return { types: [...dt.types], prevented: ev.defaultPrevented, effect: dt.dropEffect };
  });
  assert(over, '.centerpane exists');
  assert(over.types.includes('Files'), `synthetic drag carries Files: ${over.types}`);
  assert(
    over.prevented && over.effect === 'none',
    `dead-space Files dragover: ${JSON.stringify(over)}`,
  );
  log('dead-space Files dragover refused (none) ✓');

  await closeApp(app, page);
  // Best-effort, as hunk-staging: the just-closed app can still hold a watch handle on Windows.
  try {
    rmSync(project, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim it */
  }
});
