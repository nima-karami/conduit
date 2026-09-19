/**
 * plan-editor — an agent's write to `<root>/.conduit/plans/<slug>.md` reaches the user, and the
 * plan opens as a live document rather than as Markdown source.
 *
 * The whole Slice 4 Check (docs/plans/2026-09-19-interactive-plan.plan.md): the toast, its Open
 * action, the editor rendering the fixture, byte-preserving write-through, external reload with the
 * agent-changed marker, and the conflict an agent write inside the debounce window raises.
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

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  const planFile = join(plans, 'identity.md');
  const fixtureText = readFileSync(FIXTURE, 'utf8');
  const readPlan = () => readFileSync(planFile, 'utf8');
  const fenceOf = (text, lang) =>
    new RegExp(`\`\`\`${lang}\\n[\\s\\S]*?\\n\`\`\``).exec(text)?.[0] ?? null;

  const untilFile = async (holds, budgetMs) => {
    const started = Date.now();
    for (;;) {
      if (holds(readPlan())) return Date.now() - started;
      if (Date.now() - started >= budgetMs) return null;
      await page.waitForTimeout(50);
    }
  };
  const visible = (locator, timeout) =>
    locator
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);

  // (a) Type into the first paragraph: the file must differ in that paragraph and nowhere else.
  const prose = editor.locator('[contenteditable="true"]').first();
  await prose.locator('p').first().click();
  await page.keyboard.type(' XYZZY-EDIT');

  const wrote = await untilFile((t) => t.includes('XYZZY-EDIT'), 2500);
  assert(wrote !== null, 'an edit to a paragraph must reach the file within 2 s');
  log(`paragraph edit written through in ${wrote} ms ✓`);

  const edited = readPlan();
  assert(
    fenceOf(edited, 'ts') === fenceOf(fixtureText, 'ts'),
    'the ts fence must be byte-identical after editing a paragraph',
  );
  assert(
    fenceOf(edited, 'mermaid') === fenceOf(fixtureText, 'mermaid'),
    'the mermaid fence must be byte-identical after editing a paragraph',
  );
  assert(
    edited.startsWith('---\ntitle: Identity service\n---\n'),
    'the frontmatter must be re-attached to every write',
  );
  assert(edited.includes('# Identity service'), 'the heading must keep its bytes');
  assert(
    edited.includes(
      'Transactions carry a payer id, so the transaction service looks an account up on every\nwrite.',
    ),
    'an untouched paragraph must keep its bytes, hard wrap and all',
  );
  log('only the edited paragraph changed; fences and frontmatter byte-identical ✓');

  // (b) An agent rewrite while the editor is idle reloads in place and marks exactly that block.
  // The reload swaps the whole document, so it waits out a live caret; move focus off first.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(800);

  const beforeReload = readPlan();
  const reloaded = beforeReload.replace(
    'That lookup is the only coupling',
    'AGENT-EDIT-1 is the only coupling',
  );
  assert(
    reloaded !== beforeReload,
    'the external rewrite anchored on text that is no longer there',
  );
  writeFileSync(planFile, reloaded, 'utf8');

  assert(
    await visible(editor.locator('text=AGENT-EDIT-1').first(), 5000),
    'an agent rewrite while idle must render in place',
  );
  const marked = page.locator('.plan__editor [data-changed="true"]');
  const markedCount = await marked.count();
  assert(markedCount === 1, `exactly one block must carry [data-changed], got ${markedCount}`);
  const markedText = (await marked.first().textContent()) ?? '';
  assert(
    markedText.includes('AGENT-EDIT-1'),
    `the marked block must be the changed one, got "${markedText.slice(0, 80)}"`,
  );
  log('external reload rendered and marked exactly the changed block ✓');

  // (c) An agent rewrite inside the 300 ms write debounce is a conflict, never a merge.
  await prose.locator('p').first().click();
  await page.keyboard.type(' PENDING-EDIT');
  await page.waitForTimeout(120);

  const beforeConflict = readPlan();
  const theirs = beforeConflict.replace(
    'Transactions carry a payer id',
    'AGENT-EDIT-2 carry a payer id',
  );
  assert(theirs !== beforeConflict, 'the conflicting rewrite anchored on text that is not there');
  writeFileSync(planFile, theirs, 'utf8');

  const banner = page.locator('.plan__conflict');
  assert(
    await visible(banner, 5000),
    'an agent write inside the debounce window must raise the conflict banner',
  );

  // Well past the debounce: the pending edit must still not be on disk.
  await page.waitForTimeout(1200);
  const held = readPlan();
  assert(
    held.includes('AGENT-EDIT-2'),
    'the agent’s text must still be on disk while the conflict stands',
  );
  assert(!held.includes('PENDING-EDIT'), 'write-through must stay paused until the human chooses');
  log('conflict banner shown and write-through paused ✓');

  await banner.locator('button', { hasText: 'Load theirs' }).click();
  assert(
    await visible(editor.locator('text=AGENT-EDIT-2').first(), 5000),
    'Load theirs must render the agent’s version',
  );
  await page.waitForTimeout(600);
  const settled = readPlan();
  assert(
    settled.includes('AGENT-EDIT-2') && !settled.includes('PENDING-EDIT'),
    'Load theirs discards the pending edit and leaves the agent’s bytes on disk',
  );
  log('Load theirs adopted the agent’s version ✓');

  log('PASS ✓ — toast → Open → live document → write-through → reload → conflict');
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
