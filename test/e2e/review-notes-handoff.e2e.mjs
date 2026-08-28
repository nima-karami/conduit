/**
 * Review notes + agent handoff (real-app smoke, spec 2026-08-27-review-supercharge §7 Lane F).
 *
 * Two launches against ONE fixture repo, on ONE user-data dir. What only the real app can answer:
 *  - the note lands in `.conduit/review-notes.json` as an ADR 0002 ENVELOPE,
 *  - Review hides that artifact from its OWN change list while the Changes panel still shows it,
 *  - a note survives a restart and RE-ANCHORS when its line moves (alpha.ts), and is listed as
 *    detached — never dropped — when its line is gone (beta.ts),
 *  - the handoff reaches the TERMINAL BUS for the Review's own sessionId carrying the RE-ANCHORED
 *    line (not the stored one), grouped by file, with no trailing newline, and stamps `sentAt`,
 *  - the send is offered ONLY while the foreground program has bracketed paste on, and falls back
 *    to the clipboard otherwise — without that guard a multi-line paste into a bare shell prompt
 *    would execute the reviewer's notes line by line.
 *
 * The handoff is asserted on the SECOND launch on purpose: only there has alpha.ts's note moved
 * off its stored line, which is the case that catches a builder sending `note.line`.
 *
 * Both re-anchoring cases are set up before the SAME restart on purpose: an open Review holds its
 * per-file diff in app.tsx's cache and only re-reads it when a hunk op invalidates it, so an edit
 * made under a live card is not visible to that card. Pre-existing behaviour, not this lane's.
 *
 * NOT asserted here: that a `.conduit/` write stays out of `fsChanged` (src/watch-filter.ts).
 * The project watcher has a standing background rate in any repo the app is statusing — `git
 * status` touches `.git/`, `.git/` is deliberately not excluded (branch / index / refs changes
 * must get through), and the refresh fsChanged triggers runs git again. Measured while writing
 * this scenario at ~6 emits per 3s idle against the watcher's own 300ms debounce ceiling of 10,
 * so a leak of N extra writes cannot push the count far enough to be told apart from background.
 * The pure predicate is pinned instead, in test/unit/watch-filter.test.ts.
 *
 * Windows only. Run it ALONE on a quiet machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[review-notes-handoff] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('review-notes-handoff');
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'conduit-rnh-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-rnh-ud-'));
const notesPath = join(root, '.conduit', 'review-notes.json');

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

/** 30 declarations; the 13th is the one that gets edited, so a note on it has real context. */
const base = (p) => `${lines(30, (i) => `const ${p}${i} = ${i};`)}\n`;
const ALPHA_BASE = base('a');
const BETA_BASE = base('b');
const ALPHA_EDITED = 'const a12 = 1200;';
const BETA_EDITED = 'const b12 = 1200;';
const ALPHA = ALPHA_BASE.replace('const a12 = 12;', ALPHA_EDITED);
const BETA = BETA_BASE.replace('const b12 = 12;', BETA_EDITED);
/** 1-based line of each change — derived, not hard-coded, so the fixture can grow. */
const NOTED_LINE = ALPHA.split('\n').indexOf(ALPHA_EDITED) + 1;
const HEADER_LINES = 5;

writeFileSync(join(root, 'alpha.ts'), ALPHA_BASE);
writeFileSync(join(root, 'beta.ts'), BETA_BASE);
git('init', '-q');
git('config', 'user.email', 'e2e@conduit.test');
git('config', 'user.name', 'e2e');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.autocrlf', 'false');
git('add', '.');
git('commit', '-qm', 'base');

writeFileSync(join(root, 'alpha.ts'), ALPHA);
writeFileSync(join(root, 'beta.ts'), BETA);
log(`fixture: ${root} (notes go on line ${NOTED_LINE} of each file)`);

const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');

async function launch() {
  const launched = await launchApp({ userDataDir });
  const { page } = launched;
  // The opt-in paste spy has to exist BEFORE the bundle runs — it is what gates the bus's test
  // seam, exactly as window.__terms gates terminal-pane's. addInitScript only applies to a fresh
  // document, so the page is reloaded once to pick it up.
  await page.addInitScript(() => {
    window.__conduitPasteSpy = [];
    // Lets the test put the terminal into (and out of) bracketed-paste mode the way a real agent
    // TUI does — by writing DECSET 2004 — instead of reaching into the bus.
    window.__terms = {};
  });
  await page.reload();
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  return launched;
}

const cardReady = (page, file) =>
  page.waitForFunction(
    (f) => {
      const card = document.querySelector(`.review .rcard[data-path="${f}"]`);
      return !!card && !card.querySelector('.rcard__notice--loading');
    },
    file,
    { timeout: 20000 },
  );

/** Open the fixture repo and put Review on screen with its cards + note controls ready. */
async function openReview(page) {
  const sessionId = await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
  await page.click('.git-indicator__review');
  await cardReady(page, 'alpha.ts');
  await cardReady(page, 'beta.ts');
  // The load gate: every note control is disabled until the first review:notes push (§4).
  await page.waitForFunction(
    () => document.querySelector('.rline__note')?.disabled === false,
    null,
    { timeout: 15000 },
  );
  return sessionId;
}

/** The `+` on the NEW-side row for line `n` of `file`. A changed line renders twice — a del row
 *  carrying the old side and an add row carrying the new — so the side has to be named. */
const plusOnLine = (page, file, n) =>
  page
    .locator(
      `.rcard[data-path="${file}"] .rline__note[data-note-side="new"][data-note-line="${n}"]`,
    )
    .first();

/** Open the composer on that row, type `body`, save with Mod+Enter, wait for the thread. */
async function addNote(page, file, n, body, expected) {
  await plusOnLine(page, file, n).click({ force: true });
  await page.waitForSelector('.rnote-composer__field', { state: 'visible', timeout: 8000 });
  await page.fill('.rnote-composer__field', body);
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(
    (want) => document.querySelectorAll('.review .rnote').length === want,
    expected,
    { timeout: 8000 },
  );
}

const noteBodies = (page, file) =>
  page.evaluate(
    (f) =>
      [...document.querySelectorAll(`.rcard[data-path="${f}"] .rnote__body`)].map((e) =>
        (e.textContent ?? '').trim(),
      ),
    file,
  );

/** Turn bracketed paste on/off from the program side, as an agent TUI starting or exiting does. */
const setBracketedPaste = (page, sid, on) =>
  page.evaluate(
    ([s, seq]) => new Promise((r) => window.__terms[s].write(seq, r)),
    [sid, on ? '\u001b[?2004h' : '\u001b[?2004l'],
  );

const sendLabel = (page) =>
  page.evaluate(() => document.querySelector('.review__send')?.textContent ?? '');

const waitForSendLabel = (page, re) =>
  page.waitForFunction(
    (src) => new RegExp(src).test(document.querySelector('.review__send')?.textContent ?? ''),
    re.source,
    { timeout: 8000 },
  );

let firstApp = null;
let secondApp = null;
let firstPage = null;
let secondPage = null;

try {
  // ── Launch 1 ─────────────────────────────────────────────────────────────────────────────────
  const first = await launch();
  firstApp = first.app;
  firstPage = first.page;
  const page = first.page;
  await openReview(page);
  log('Review open with the fixture changeset ✓');

  // (1) The `+` is inert until its row is hovered — the hover-obstruction rule.
  const atRest = await page.evaluate(() => {
    const b = document.querySelector('.rline__note');
    return b ? getComputedStyle(b).pointerEvents : null;
  });
  assert(atRest === 'none', `the + must be pointer-events:none at rest; got ${atRest}`);
  log('the + affordance is inert until its row is hovered ✓');

  // (2) A note on each file's changed line.
  await addNote(page, 'alpha.ts', NOTED_LINE, 'this constant needs a name', 1);
  await addNote(page, 'beta.ts', NOTED_LINE, 'and this one is dead', 2);
  log('the composer saved a note onto a line in each file ✓');

  // (3) They landed on disk, ENVELOPED (ADR 0002).
  await page.waitForTimeout(800); // the host writes after it broadcasts
  assert(existsSync(notesPath), `review-notes.json was not written to ${notesPath}`);
  const envelope = JSON.parse(readFileSync(notesPath, 'utf8'));
  assert(envelope.conduit === 1, `envelope.conduit should be 1; got ${envelope.conduit}`);
  assert(
    envelope.kind === 'review-notes',
    `envelope.kind should be review-notes; got ${envelope.kind}`,
  );
  assert(typeof envelope.updatedAt === 'number', 'envelope.updatedAt should be a number');
  assert(envelope.data.version === 1, 'the payload should self-version at 1');
  assert(envelope.data.notes.length === 2, `expected 2 notes; got ${envelope.data.notes.length}`);
  const saved = envelope.data.notes.find((n) => n.path === 'alpha.ts');
  assert(saved, 'the alpha.ts note should be stored under its repo-relative path');
  assert(saved.line === NOTED_LINE, `note.line should be ${NOTED_LINE}; got ${saved.line}`);
  assert(saved.side === 'new', `note.side should be new; got ${saved.side}`);
  assert(
    saved.snippet === ALPHA_EDITED,
    `the snippet should be the new-side text; got ${saved.snippet}`,
  );
  assert(saved.body === 'this constant needs a name', 'the body should round-trip');
  assert(typeof saved.anchor === 'string' && saved.anchor.length > 0, 'the note must be anchored');
  log('both notes persisted to .conduit/review-notes.json as one envelope ✓');

  // (4) Review does not list its own artifact, but the Changes panel does (spec §2 Lane F).
  const listedInReview = await page.evaluate(
    (art) => [...document.querySelectorAll(`.review .rcard`)].some((c) => c.dataset.path === art),
    '.conduit/review-notes.json',
  );
  assert(!listedInReview, 'Review must not list the notes artifact it just wrote');
  // The Changes panel is the OTHER half of the rule: it must still show the file, because
  // committing or gitignoring it is a decision only the user can make.
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Changes'))
      ?.click();
  });
  await page.waitForSelector('.change .change__file', { state: 'visible', timeout: 15000 });
  const listedInChanges = await page.evaluate(() =>
    [...document.querySelectorAll('.change')].some((c) =>
      (c.textContent ?? '').includes('review-notes.json'),
    ),
  );
  assert(
    listedInChanges,
    'the Changes panel must still list the artifact — it is a real file to commit or gitignore',
  );
  log('the notes artifact is hidden from Review but still listed in Changes ✓');
  await closeApp(firstApp, page);
  firstApp = null;
  log('first launch closed');

  // ── Between launches ─────────────────────────────────────────────────────────────────────────
  // alpha.ts: 5 lines pushed in above the note → it must FOLLOW its line.
  writeFileSync(
    join(root, 'alpha.ts'),
    `${lines(HEADER_LINES, (i) => `// header ${i}`)}\n${ALPHA}`,
  );
  // beta.ts: the noted line is deleted outright → the note must be listed as DETACHED.
  writeFileSync(join(root, 'beta.ts'), BETA.replace(`${BETA_EDITED}\n`, ''));

  // ── Launch 2 ─────────────────────────────────────────────────────────────────────────────────
  const second = await launch();
  secondApp = second.app;
  secondPage = second.page;
  const page2 = second.page;
  const sessionId2 = await openReview(page2);

  await page2.waitForFunction(
    () => document.querySelectorAll('.rcard[data-path="alpha.ts"] .rnote').length === 1,
    null,
    { timeout: 20000 },
  );
  const followed = await page2.evaluate(() => {
    const row = document.querySelector(
      '.rcard[data-path="alpha.ts"] .rnote',
    )?.previousElementSibling;
    return row?.querySelector('.rline__note')?.dataset.noteLine ?? null;
  });
  assert(
    followed === String(NOTED_LINE + HEADER_LINES),
    `the note should have followed its line from ${NOTED_LINE} to ${NOTED_LINE + HEADER_LINES}; got ${followed}`,
  );
  assert(
    (await noteBodies(page2, 'alpha.ts'))[0] === 'this constant needs a name',
    'the body should survive the restart',
  );
  log('the note survived the restart and followed its moved line ✓');

  await page2.waitForSelector('.rcard[data-path="beta.ts"] .rcard__detached', { timeout: 25000 });
  const detachedText = await page2.textContent('.rcard[data-path="beta.ts"] .rcard__detached');
  assert(
    detachedText.includes('lost its place') && detachedText.includes(BETA_EDITED),
    `the detached notice must name the line it was on; got: ${detachedText}`,
  );
  log('a note whose line is gone is listed as detached, with its snippet ✓');

  // ── The handoff, now that alpha.ts’s note sits five lines below where it was stored ──────

  // A bare cmd.exe has NOT set DECSET 2004, so xterm’s paste() would not bracket the text and
  // every newline would be a carriage return the shell executes. The control must refuse.
  await waitForSendLabel(page2, /Copy as markdown/);
  log('a terminal without bracketed paste is not offered the send ✓');

  await setBracketedPaste(page2, sessionId2, true);
  await waitForSendLabel(page2, /Send to agent \(2\)/);
  log('an agent TUI turning bracketed paste on flips the control to Send ✓');

  mkdirSync(shotDir, { recursive: true });
  await page2.screenshot({ path: join(shotDir, 'review-notes-handoff-2.png') }).catch(() => {});

  await page2.click('.review__send');
  const delivered = await page2.waitForFunction(
    () => (window.__conduitPasteSpy.length > 0 ? window.__conduitPasteSpy[0] : null),
    null,
    { timeout: 8000 },
  );
  const paste = await delivered.jsonValue();
  assert(
    paste.sessionId === sessionId2,
    `the handoff must target the Review's session ${sessionId2}; got ${paste.sessionId}`,
  );
  assert(
    paste.text.startsWith('Review notes on 2 files (working tree):'),
    `unexpected handoff header:\n${paste.text}`,
  );
  assert(
    paste.text.includes('### alpha.ts') && paste.text.includes('### beta.ts'),
    `the handoff must group by file:\n${paste.text}`,
  );
  // The point of asserting this after a restart with 5 lines pushed in: `reanchor` never
  // rewrites `note.line`, so a builder reading the stored line would say L13 here.
  assert(
    paste.text.includes(
      `- L${NOTED_LINE + HEADER_LINES} (\`${ALPHA_EDITED}\`): this constant needs a name`,
    ),
    `the handoff must carry the RE-ANCHORED line, not the stored one:\n${paste.text}`,
  );
  assert(
    !paste.text.includes(`- L${NOTED_LINE} (`),
    `the stored line ${NOTED_LINE} must not appear:\n${paste.text}`,
  );
  assert(
    paste.text.includes(
      `- (was line ${NOTED_LINE}: \`${BETA_EDITED}\` — that line is gone): and this one is dead`,
    ),
    `a detached note must say so rather than quote a stale line:\n${paste.text}`,
  );
  assert(
    paste.text.endsWith('Please address these and reply with what you changed.'),
    'the handoff must end with the ask',
  );
  assert(!paste.text.endsWith('\n'), 'the handoff must carry NO trailing newline');
  log('Send to agent delivered the re-anchored markdown to the bus for the right session ✓');

  await waitForSendLabel(page2, /Send to agent \(0\)/);
  await page2.waitForTimeout(600);
  const afterSend = JSON.parse(readFileSync(notesPath, 'utf8')).data.notes;
  assert(
    afterSend.every((n) => typeof n.sentAt === 'string'),
    'every sent note must be stamped with sentAt',
  );
  assert(
    afterSend.every((n) => n.line === NOTED_LINE),
    'the STORED line must be left alone — re-anchoring is a view computation (plan assumption 4)',
  );
  log('sent notes are stamped, the count drops to 0, and the stored line is untouched ✓');

  // The user drops out of the agent TUI: the send must stop being offered.
  await setBracketedPaste(page2, sessionId2, false);
  await waitForSendLabel(page2, /Copy as markdown/);
  assert(
    (await sendLabel(page2)).includes('Copy as markdown'),
    'leaving the agent TUI must take the send away',
  );
  log('leaving bracketed-paste mode falls the control back to the clipboard ✓');

  await closeApp(secondApp, page2);
  secondApp = null;

  log('PASS ✓ review-notes-handoff');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else {
    console.error('[review-notes-handoff] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    if (firstApp) await closeApp(firstApp, firstPage);
    if (secondApp) await closeApp(secondApp, secondPage);
  } catch {
    /* already gone */
  }
  process.exit(isAssertion ? 1 : 2);
}
