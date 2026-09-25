/**
 * os-drag-out (docs/specs/2026-09-24-os-drag-out.md): Copy → OS clipboard request and the
 * dead-space navigation guard. S0 chose outcome C (docs/runs/2026-09-24-os-drag-out/s0-spike.md),
 * so there are no native drag-out cases (plan Task 7.1, outcomes A / A′) yet.
 *
 * Under CONDUIT_E2E the host never writes the real clipboard: it records the payload in
 * globalThis.__conduitClipboardLog instead (electron/drag-out-host.ts).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { assert, closeApp, openSession, runScenario, tapBridge } from './harness.mjs';

// Mirrors OS_FILE_CLIPBOARD.win32 in src/drag-out-policy.ts (S0 F4: PASS); flip both together.
const WIN32_OS_CLIPBOARD = true;

const project = mkdtempSync(join(tmpdir(), 'conduit-dragout-'));
const NAME = 'ünï 日本.txt';
// The session opens with forward slashes (harness openSession) and rows join with '/'; the host
// hands PowerShell the resolved native form, so that is what stdin must carry.
const file = win32.resolve(project, NAME);
writeFileSync(file, 'bytes');

await runScenario('os-drag-out', async ({ app, page, log }) => {
  await openSession(page, { path: project });
  await tapBridge(page);
  await page.locator('.rtab', { hasText: 'Files' }).click();

  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: NAME }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 10_000 });
  await row.first().click();
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(500);

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

  const before = page.url();
  await page.evaluate(() => {
    location.href = 'file:///C:/Windows/win.ini';
  });
  await page.waitForTimeout(500);
  assert(
    before.includes('index.html') && page.url() === before,
    `still the app shell: ${page.url()}`,
  );
  log('file: navigation blocked ✓');

  const over = await page.evaluate(() => {
    const target = document.querySelector('.center');
    if (!target) return null;
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.txt'));
    dt.dropEffect = 'copy';
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(ev);
    return { types: [...dt.types], prevented: ev.defaultPrevented, effect: dt.dropEffect };
  });
  assert(over, '.center exists');
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
