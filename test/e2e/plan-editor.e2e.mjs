/**
 * plan-editor — an agent's write to `<root>/.conduit/plans/<slug>.md` reaches the user, and the
 * plan opens as a live document rather than as Markdown source.
 *
 * The whole Slice 4 Check (docs/plans/2026-09-19-interactive-plan.plan.md): the toast, its Open
 * action, the editor rendering the fixture, byte-preserving write-through, external reload with the
 * agent-changed marker, and the conflict an agent write inside the debounce window raises.
 *
 * Plus the two bindings runtime QA found broken, which no unit test can reach:
 *  (d) a plan DELETED while its tab is open reaches the not-found state with a working Close —
 *      behind the doc store's generic `file.error` branch it was a dead "File could not be read.",
 *  (e) a plan written into a project that is NOT the active session opens bound to ITS OWN
 *      session, so Send pastes to the agent that wrote it rather than to whoever is on screen.
 *      Two projects are open on purpose: with one, every wrong answer is also the right one.
 *  (f) a plan the host refuses to read offers Open as text and actually renders the bytes.
 *
 * `.conduit/plans/` is created BEFORE the project is opened and the plan written after: the host's
 * watcher can only attach to a directory that exists, and it otherwise re-checks on a 2 s poll,
 * which would race the write it is supposed to see (electron/plan-watcher.ts `arm`).
 *
 * The paste spy and `window.__terms` have to exist BEFORE the bundle runs (terminal-bus.ts gates
 * the seam on the array), so the page is reloaded once with the init script, as
 * review-notes-handoff.e2e.mjs does. Bracketed paste is turned on for BOTH sessions from the
 * program side: a bare cmd.exe has not set DECSET 2004, and with only the owning session armed a
 * mis-bound tab would fail as a timeout on the button label rather than on where the paste went.
 *
 * The app is shut down before the temp dirs are removed — the sessions' shells have them as cwd,
 * so an rmSync alongside a live Electron fails with EPERM and masks whatever the scenario found.
 *
 * Windows-only, matching the suite.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, launchApp, makeLog, openSession, tapBridge } from './harness.mjs';

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

/** The OTHER project — opened second, so it is the active session while (e) runs. */
const otherRoot = mkdtempSync(join(tmpdir(), 'conduit-plan-other-'));
mkdirSync(join(otherRoot, '.conduit', 'plans'), { recursive: true });

const SECOND_SLUG = 'second';
const SECOND_MD = '# Second plan\n\nThe transaction service is wrong here.\n';

let launched = null;
let code = 0;
try {
  launched = await launchApp();
  const { page } = launched;

  await page.addInitScript(() => {
    window.__conduitPasteSpy = [];
    window.__terms = {};
  });
  await page.reload();
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);

  const sessionA = await openSession(page, { path: root });
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

  // (d) The plan is deleted under the open tab: not-found, not a dead pane.
  const planTab = page.locator('.tab', { hasText: 'identity.md' }).first();
  assert((await planTab.count()) === 1, 'the plan tab must still be open before it is deleted');
  rmSync(planFile, { force: true });

  const deleted = page.locator('.plan__state', { hasText: 'This plan was deleted' }).first();
  assert(
    await visible(deleted, 8000),
    'deleting an open plan must reach the not-found state, not "File could not be read."',
  );
  const notice = await page.locator('.viewer__notice').count();
  assert(notice === 0, 'the generic doc-store error notice must never own a plan pane');
  const recreate = deleted.locator('button', { hasText: 'Recreate empty' });
  assert((await recreate.count()) === 1, 'the not-found state must offer Recreate empty');
  log('a deleted plan shows the not-found state with its two actions ✓');

  await deleted.locator('button', { hasText: 'Close' }).click();
  const closed = await planTab
    .waitFor({ state: 'detached', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  assert(closed, 'the not-found state’s Close must close the plan’s own tab');
  log('Close closed the dead tab ✓');

  // (e) A plan in a project that is NOT on screen binds to the session that owns it.
  const sessionB = await openSession(page, { path: otherRoot });
  assert(sessionB !== sessionA, 'the second project must open its own session');
  await page.waitForTimeout(1500);

  writeFileSync(join(plans, `${SECOND_SLUG}.md`), SECOND_MD, 'utf8');
  const secondToast = page
    .locator('.toast', { hasText: `Agent updated plan ${SECOND_SLUG}` })
    .first();
  assert(
    await visible(secondToast, 6000),
    'a plan written into a non-active project must still raise its toast',
  );
  await secondToast.locator('.toast__action', { hasText: 'Open' }).click();

  const secondEditor = page.locator('.plan__editor').first();
  assert(
    await visible(secondEditor, 8000),
    'the toast’s Open must open the plan of the project that owns it',
  );
  assert(
    ((await secondEditor.textContent()) ?? '').includes('Second plan'),
    'the opened plan must be the one the toast named',
  );

  // Both terminals accept a bracketed paste, so the Send control is live wherever the tab is
  // bound — the assertion below is about WHICH terminal receives it, not whether one can.
  for (const sid of [sessionA, sessionB]) {
    await page.evaluate(
      ([s, seq]) => new Promise((r) => window.__terms[s]?.write(seq, r)),
      [sid, '\u001b[?2004h'],
    );
  }

  // Send counts human-changed blocks, and a freshly loaded plan has none.
  await secondEditor.locator('[contenteditable="true"] p').first().click();
  await page.keyboard.type(' OWNER-EDIT');
  const secondFile = join(plans, `${SECOND_SLUG}.md`);
  const wroteSecond = await (async () => {
    const started = Date.now();
    for (;;) {
      if (readFileSync(secondFile, 'utf8').includes('OWNER-EDIT')) return true;
      if (Date.now() - started >= 4000) return false;
      await page.waitForTimeout(50);
    }
  })();
  assert(wroteSecond, 'the edit must reach the plan file of the project that owns it');

  await page.waitForFunction(
    () => /Send to agent \(\d+\)/.test(document.querySelector('.plan__send')?.textContent ?? ''),
    null,
    { timeout: 10000 },
  );
  await page.click('.plan__send');
  const pasted = await page
    .waitForFunction(() => window.__conduitPasteSpy[0] ?? null, null, { timeout: 8000 })
    .then((h) => h.jsonValue());
  assert(
    pasted.sessionId === sessionA,
    `Send must paste into the OWNING project's terminal (${sessionA}), not the active one (${sessionB}); got ${pasted.sessionId}`,
  );
  assert(
    pasted.text.includes(`${SECOND_SLUG}.md`) && pasted.text.includes('OWNER-EDIT'),
    `the handoff must describe the plan that was edited:\n${pasted.text}`,
  );
  log('a plan opened while another project was active sends to its own agent ✓');

  // (f) A plan the host refuses to read is still readable AS TEXT (spec §8 load-failed).
  // The toast is raised by the VALID write and the file is corrupted behind it: the watcher
  // skips a plan it cannot read (electron/plan-watcher.ts `settle`), so the load-failed state is
  // only ever reached through `plan:load` — i.e. by opening a file that is already bad.
  const badFile = join(plans, 'bad.md');
  writeFileSync(badFile, '# Bad plan\n\nstill fine at this point\n', 'utf8');
  const badToast = page.locator('.toast', { hasText: 'Agent updated plan bad' }).first();
  assert(await visible(badToast, 6000), 'the valid write must raise its toast before corruption');
  // 0xff/0xfe are invalid UTF-8 and are not NUL, so `readFile` still hands the renderer text
  // (lossily decoded) even though `readPlan` refuses it — which is what Open as text shows.
  writeFileSync(badFile, Buffer.from([0x23, 0x20, 0x42, 0x61, 0x64, 0x0a, 0xff, 0xfe, 0x41]));
  await badToast.locator('.toast__action', { hasText: 'Open' }).click();

  const failed = page.locator('.plan__state', { hasText: "Can't open this plan" }).first();
  assert(await visible(failed, 8000), 'an unreadable plan must reach the load-failed state');
  assert(
    ((await failed.textContent()) ?? '').includes('not valid UTF-8'),
    'the load-failed state must name the reason',
  );
  const asText = failed.locator('button', { hasText: 'Open as text' });
  assert(
    (await asText.count()) === 1,
    'load-failed must offer Open as text — a reason with no way to see the bytes is a dead pane',
  );
  await asText.click();
  assert(
    await visible(page.locator('.plan__source-view .monaco-editor').first(), 8000),
    'Open as text must render the file in the source view',
  );
  // Polled: Monaco paints its view lines a frame or two after the container lands.
  const showedBytes = await page
    .waitForFunction(
      () => (document.querySelector('.plan__source-view')?.textContent ?? '').includes('Bad'),
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(showedBytes, 'the source view must show the file’s own bytes, not an empty editor');
  log('a plan that failed to load can still be read as text ✓');

  log(
    'PASS ✓ — toast → Open → live document → write-through → reload → conflict → deleted → owning session → load-failed as text',
  );
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
for (const dir of [root, otherRoot]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A handle the OS has not released yet; tmpdir is reaped anyway.
  }
}
process.exit(code);
