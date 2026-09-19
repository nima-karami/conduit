/**
 * plan-handoff — the round trip back to the agent: a comment on a block lands in the sidecar
 * anchored to that block's hash, a structural edit counts as a changed block, and Send pastes the
 * plan path, the new fence and the comment text into the session's terminal, then stamps the
 * comments and replaces the baseline so the bar falls to "Nothing to send".
 *
 * The whole Slice 6 Check (docs/plans/2026-09-19-interactive-plan.plan.md).
 *
 * Setup matches plan-editor / plan-blocks: `.conduit/plans/` exists before the project is opened
 * (the host watcher can only attach to a directory that exists), the plan is written after, and the
 * app is shut down before the temp dir goes (the session's shell holds it as its cwd).
 *
 * A change reaches disk ~500 ms after the last input — Milkdown's listener debounces 200 ms and
 * PlanView's write 300 ms — so every check polls a file rather than sleeping a fixed time.
 *
 * The paste spy and `window.__terms` have to exist BEFORE the bundle runs (terminal-bus.ts gates
 * the seam on the array), so the page is reloaded once with the init script, exactly as
 * review-notes-handoff.e2e.mjs:89 does. Bracketed paste is turned on from the program side, since
 * a bare cmd.exe prompt has not set DECSET 2004 and the bar would offer Copy instead of Send.
 *
 * Windows-only, matching the suite.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, launchApp, makeLog, openSession, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[plan-handoff] SKIP — suite is Windows-only');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'plan', 'identity.md');
const log = makeLog('plan-handoff');

const COMMENT = 'txn must not call identity';

const root = mkdtempSync(join(tmpdir(), 'conduit-planhandoff-'));
const plans = join(root, '.conduit', 'plans');
mkdirSync(plans, { recursive: true });

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

  const sessionId = await openSession(page, { path: root });
  await page.waitForTimeout(1500);

  copyFileSync(FIXTURE, join(plans, 'identity.md'));
  log('wrote identity.md into .conduit/plans');

  const toast = page.locator('.toast', { hasText: 'Agent updated plan identity' }).first();
  await toast.waitFor({ state: 'visible', timeout: 5000 });
  await toast.locator('.toast__action', { hasText: 'Open' }).click();

  const editor = page.locator('.plan__editor').first();
  await editor.waitFor({ state: 'visible', timeout: 5000 });
  log('plan open in the editor ✓');

  const planFile = join(plans, 'identity.md');
  const sidecar = join(plans, 'identity.comments.json');
  const readPlan = () => readFileSync(planFile, 'utf8');
  const readComments = () => {
    if (!existsSync(sidecar)) return null;
    try {
      return JSON.parse(readFileSync(sidecar, 'utf8'));
    } catch {
      return null; // a half-written file between the rename and the read
    }
  };
  const fenceOf = (text, lang) =>
    new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``).exec(text)?.[1] ?? null;

  const until = async (holds, budgetMs) => {
    const started = Date.now();
    for (;;) {
      const value = holds();
      if (value) return value;
      if (Date.now() - started >= budgetMs) return null;
      await page.waitForTimeout(50);
    }
  };

  const sendText = () =>
    page.evaluate(() => document.querySelector('.plan__send')?.textContent ?? '');
  const waitForSend = (re) =>
    page.waitForFunction(
      (src) => new RegExp(src).test(document.querySelector('.plan__send')?.textContent ?? ''),
      re.source,
      { timeout: 10000 },
    );

  // The diagram block is the last top-level block of the fixture; its hash is what the comment
  // must anchor to, and it is also the block the edge delete changes.
  const diagramBefore = fenceOf(readPlan(), 'mermaid') ?? '';
  assert(diagramBefore.includes('txn -->|lookup| identity'), 'the fixture must have the txn edge');

  // ── hover the diagram block → the comment gutter → a comment ─────────────────────────────
  const flow = page.locator('.planflow').first();
  await flow.waitFor({ state: 'visible', timeout: 10000 });
  await flow.hover();

  const gutter = page.locator('.plan__gutter').first();
  const gutterUp = await gutter
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  assert(gutterUp, 'hovering a block must reveal the .plan__gutter comment affordance');
  await gutter.click();

  await page.waitForSelector('.plan__composer .rnote-composer__field', {
    state: 'visible',
    timeout: 5000,
  });
  await page.fill('.plan__composer .rnote-composer__field', COMMENT);
  await page.keyboard.press('Control+Enter');

  const saved = await until(() => {
    const data = readComments()?.data;
    return data?.comments?.length === 1 ? data : null;
  }, 8000);
  assert(saved !== null, 'the comment must reach .conduit/plans/identity.comments.json');

  const comment = saved.comments[0];
  assert(comment.status === 'open', `the comment must be open; got ${comment.status}`);
  assert(comment.author === 'human', `the comment must be the human's; got ${comment.author}`);
  assert(comment.text === COMMENT, `the comment text must round-trip; got "${comment.text}"`);
  assert(comment.sentAt === undefined, 'a fresh comment must not be stamped as sent');
  const envelope = readComments();
  assert(
    envelope.kind === 'plan-comments',
    `envelope.kind should be plan-comments; got ${envelope.kind}`,
  );
  // Anchored to the DIAGRAM — the fixture's fifth and last top-level block — not to block 0,
  // which is where the panel's own "Add comment" path would have put it.
  assert(
    comment.anchor.index === 4,
    `the comment must anchor to the diagram block (index 4); got ${comment.anchor.index}`,
  );
  assert(
    comment.anchor.snippet === '```mermaid',
    `the anchor snippet must be the diagram fence's first line; got "${comment.anchor.snippet}"`,
  );
  assert(
    typeof comment.anchor.hash === 'string' && comment.anchor.hash.length > 0,
    'the comment must carry the block hash it was written against',
  );
  log('comment saved to the sidecar, anchored to the diagram block, open and unsent ✓');

  // ── delete the `txn --> identity` edge ───────────────────────────────────────────────────
  const pointOnEdge = async (edgeId) =>
    page.evaluate((id) => {
      const g = document.querySelector(`.react-flow__edge[data-id="${id}"]`);
      const path =
        g?.querySelector('path.react-flow__edge-interaction') ?? g?.querySelector('path');
      if (!path) return null;
      const at = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM();
      if (!m) return null;
      return { x: m.a * at.x + m.c * at.y + m.e, y: m.b * at.x + m.d * at.y + m.f };
    }, edgeId);

  // Fixture edge order: e0 web→identity, e1 web→txn, e2 txn→identity.
  const edgeAt = await pointOnEdge('e2');
  assert(edgeAt !== null, 'the txn → identity edge must be on the canvas');
  await page.mouse.click(edgeAt.x, edgeAt.y, { button: 'right' });

  const menu = page.locator('.ctxmenu').first();
  await menu.waitFor({ state: 'visible', timeout: 4000 });
  await menu.locator('.ctxmenu__item', { hasText: 'Delete' }).first().click();

  const afterDelete = await until(() => {
    const fence = fenceOf(readPlan(), 'mermaid');
    return fence && !fence.includes('txn -->|lookup| identity') ? fence : null;
  }, 6000);
  assert(afterDelete !== null, 'deleting the edge must reach the file within 6 s');
  log('edge deleted and written through ✓');

  // ── the bar counts one changed block plus one open comment ───────────────────────────────
  // A bare cmd.exe has not set DECSET 2004, so the control refuses a multi-line paste until an
  // agent TUI turns bracketed paste on.
  await waitForSend(/Copy as markdown/);
  await page.evaluate(
    ([s, seq]) => new Promise((r) => window.__terms[s].write(seq, r)),
    [sessionId, '\u001b[?2004h'],
  );
  await waitForSend(/Send to agent \(2\)/);
  assert(
    (await sendText()).includes('Send to agent (2)'),
    `the bar must count the changed block and the open comment; got "${await sendText()}"`,
  );
  log('the action bar reads "Send to agent (2)" ✓');

  // ── Send ─────────────────────────────────────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__conduitPasteSpy = [];
  });
  await page.click('.plan__send');

  const delivered = await page.waitForFunction(
    () => (window.__conduitPasteSpy.length > 0 ? window.__conduitPasteSpy[0] : null),
    null,
    { timeout: 8000 },
  );
  const paste = await delivered.jsonValue();
  assert(
    paste.sessionId === sessionId,
    `the handoff must target the plan's session ${sessionId}; got ${paste.sessionId}`,
  );
  assert(
    paste.text.startsWith('Plan: .conduit/plans/identity.md — I edited it and left comments.'),
    `unexpected handoff header:\n${paste.text}`,
  );
  assert(
    paste.text.includes('Changed blocks (1):') && paste.text.includes('```mermaid'),
    `the changed diagram must be pasted as a fence:\n${paste.text}`,
  );
  assert(
    !paste.text.includes('txn -->|lookup| identity'),
    `the pasted fence must be the NEW diagram, not the one on disk before the edit:\n${paste.text}`,
  );
  assert(
    paste.text.includes('web --> identity') && paste.text.includes('web --> txn'),
    `the pasted fence must carry the surviving edges:\n${paste.text}`,
  );
  assert(
    paste.text.includes(`: "${COMMENT}"`),
    `the open comment must be in the paste:\n${paste.text}`,
  );
  assert(
    paste.text.endsWith(
      'Please revise the plan file, reply to each comment in .conduit/plans/identity.comments.json, and tell me what you changed.',
    ),
    `the handoff must end with the ask:\n${paste.text}`,
  );
  assert(!paste.text.endsWith('\n'), 'the handoff must carry NO trailing newline');
  log('Send delivered the plan path, the new fence and the comment to the bus ✓');

  // ── the sidecar is stamped and re-baselined; the bar falls silent ────────────────────────
  const hashes = await until(() => {
    const data = readComments()?.data;
    return data?.baseline && data.comments[0]?.sentAt ? data : null;
  }, 8000);
  assert(hashes !== null, 'Send must stamp sentAt and persist a baseline');
  const onDisk = hashes.baseline.blockHashes;
  assert(
    Array.isArray(onDisk) && onDisk.length === 5,
    `the baseline must list every current block hash; got ${JSON.stringify(onDisk)}`,
  );
  assert(
    typeof hashes.comments[0].sentAt === 'string',
    'the sent comment must carry an ISO sentAt',
  );

  await waitForSend(/Nothing to send/);
  log('baseline replaced with the current hashes, comment stamped, bar reads "Nothing to send" ✓');

  // ── resolve → the panel says so ──────────────────────────────────────────────────────────
  await page
    .locator('.plancomment__row')
    .first()
    .locator('button', { hasText: 'Resolve' })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      (document.querySelector('.plancomment__count')?.textContent ?? '').includes('All 1 resolved'),
    null,
    { timeout: 8000 },
  );
  log('resolving the comment leaves the panel reading "All 1 resolved" ✓');

  log('PASS ✓ — gutter comment → sidecar → changed block → Send → stamped baseline → resolved');
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[plan-handoff] ERROR:', e?.message || e);
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
