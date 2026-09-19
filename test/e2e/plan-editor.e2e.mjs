/**
 * plan-editor — an agent's write to `<root>/.conduit/plans/<slug>.md` reaches the user, and the
 * plan opens as a live document rather than as Markdown source.
 *
 * Steps 1-3 of the Slice 4 Check (docs/plans/2026-09-19-interactive-plan.plan.md): the toast, its
 * Open action, and the editor rendering the fixture. Tasks 4.4/4.5 extend this file with the
 * write-through, external-reload and conflict steps.
 *
 * `.conduit/plans/` is created BEFORE the project is opened and the plan written after: the host's
 * watcher can only attach to a directory that exists, and it otherwise re-checks on a 2 s poll,
 * which would race the write it is supposed to see (electron/plan-watcher.ts `arm`).
 *
 * The app is shut down before the temp dir is removed — the session's shell has it as its cwd, so
 * an rmSync alongside a live Electron fails with EPERM and masks whatever the scenario found.
 *
 * Windows-only, matching the suite.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, launchApp, makeLog, openSession } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[plan-editor] SKIP — suite is Windows-only');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'plan', 'identity.md');
const log = makeLog('plan-editor');

const root = mkdtempSync(join(tmpdir(), 'conduit-plan-'));
const plans = join(root, '.conduit', 'plans');
mkdirSync(plans, { recursive: true });

let launched = null;
let code = 0;
try {
  launched = await launchApp();
  const { page } = launched;

  await openSession(page, { path: root });
  // Let sendProject arm the plan watch on this root before anything lands in the directory.
  await page.waitForTimeout(1500);

  copyFileSync(FIXTURE, join(plans, 'identity.md'));
  log('wrote identity.md into .conduit/plans (external, no refocus)');

  const toast = page.locator('.toast', { hasText: 'Agent updated plan identity' }).first();
  const toasted = await toast
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  assert(toasted, 'an external plan write must raise the "Agent updated plan identity" toast');
  log('toast raised within 3 s ✓');

  await toast.locator('.toast__action', { hasText: 'Open' }).click();

  const editor = page.locator('.plan__editor').first();
  const mounted = await editor
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  assert(mounted, 'the toast’s Open action must open the plan in the plan editor');

  const text = (await editor.textContent()) ?? '';
  assert(
    text.includes('Identity service'),
    `the editor must render the fixture's heading, got "${text.slice(0, 120)}"`,
  );
  log('Open rendered .plan__editor with the fixture heading ✓');

  log('PASS ✓ — external plan write → toast → Open → live plan document');
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[plan-editor] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}

try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // A handle the OS has not released yet; tmpdir is reaped anyway.
}
process.exit(code);
