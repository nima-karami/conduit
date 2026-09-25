/**
 * review-multi-repo — Review across every repo of a multi-folder session (spec
 * docs/specs/archive/2026-09-23-mf-review.md §7: EARS 1–10 and 12–14, and the §7.2 Gherkin).
 *
 * Real-app only: the grouped list is fed by the host's per-repo `repoChanges`, marks and notes are
 * written by the host under each repo root, the fan-out stages through real git, a root leaving the
 * session is a host mutation, and a terminal sha link resolves against the PTY's live cwd.
 *
 * Fixture (the Nested tag needs a NON-repo home — mf-changes D13, plan "e2e Nested fixture"):
 *   <work>/rmb-ws/                      plain folder, the session home
 *   <work>/rmb-ws/rmb                   repo, Nested   — README.md + src/bus.ts dirty
 *   <work>/rmb-ws/vendor/proto-schemas  repo, Nested   — room.proto dirty, staged.proto staged
 *   <work>/ci                           repo, Attached — README.md + pipeline.yml dirty
 * README.md is dirty in two repos on purpose (EARS 8). `ext` is a repo outside the session (EARS
 * 13), `ac14-ws` a second multi-repo home for the glyph landing (EARS 14), `solo` a single repo.
 *
 * The chip, menus and source trigger are driven with real hit-tested clicks, never dispatchEvent.
 *
 * Windows only. Run it ALONE on a quiet machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openReview, openSession, runScenario, tapBridge } from './harness.mjs';

// --no-optional-locks: this scenario polls git while the app runs its own; a status that takes
// index.lock makes the app's git reset / restore fail, and Discard all stops at its first step.
const git = (dir, ...a) =>
  execFileSync('git', ['--no-optional-locks', ...a], { cwd: dir, encoding: 'utf8' }).trim();
const fwd = (p) => p.replace(/\\/g, '/');

/** src/folder-key.ts `folderKey` (over review-marks.ts `normalizeRoot`): the form every
 *  `data-root` and every review-marks.json key carries. */
const key = (p) => {
  const r = fwd(p).replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(r) || r.startsWith('//') ? r.toLowerCase() : r;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function makeRepo(dir, subject, files) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@conduit.test');
  git(dir, 'config', 'user.name', 'e2e');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', subject);
  return git(dir, 'rev-parse', 'HEAD');
}

const SUBJECT = {
  rmb: 'rmb: add bus',
  proto: 'proto: room schema',
  ci: 'ci: pipeline',
  ext: 'ext: outside the session',
};

function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'conduit-mfr-'));
  const home = join(work, 'rmb-ws');
  const rmb = join(home, 'rmb');
  const proto = join(home, 'vendor', 'proto-schemas');
  const ci = join(work, 'ci');
  const ext = join(work, 'ext');
  const solo = join(work, 'solo');
  makeRepo(rmb, SUBJECT.rmb, {
    'README.md': '# rmb\n\nRoom message bus.\n',
    'src/bus.ts': 'export const bus = 1;\n',
  });
  makeRepo(proto, SUBJECT.proto, { 'room.proto': 'syntax = "proto3";\nmessage Room {}\n' });
  makeRepo(ci, SUBJECT.ci, { 'README.md': '# ci\n\nPipelines.\n', 'pipeline.yml': 'on: push\n' });
  const extSha = makeRepo(ext, SUBJECT.ext, { 'ext-only.txt': 'only in ext\n' });
  makeRepo(solo, 'solo: init', { 'app.ts': 'export const app = 1;\n' });
  writeFileSync(join(rmb, 'README.md'), '# rmb\n\nRoom message bus, now with rooms.\n');
  writeFileSync(join(rmb, 'src/bus.ts'), 'export const bus = 2;\nexport const rooms = [];\n');
  writeFileSync(
    join(proto, 'room.proto'),
    'syntax = "proto3";\nmessage Room {\n  string id = 1;\n}\n',
  );
  // The narrowed Staged scope (Gherkin) needs something staged in proto.
  writeFileSync(join(proto, 'staged.proto'), 'syntax = "proto3";\nmessage Staged {}\n');
  git(proto, 'add', 'staged.proto');
  writeFileSync(join(ci, 'README.md'), '# ci\n\nPipelines for every repo.\n');
  writeFileSync(join(ci, 'pipeline.yml'), 'on: [push, pull_request]\n');
  writeFileSync(join(solo, 'app.ts'), 'export const app = 2;\n');
  return { work, home, rmb, proto, ci, ext, extSha, solo };
}

/** A second home whose nested target repo sits BETWEEN two filler repos (nested repos sort by
 *  path), so landing on its card needs a real scroll and leaves it as the anchor. */
function glyphFixture(work) {
  const home = join(work, 'ac14-ws');
  const fillerA = join(home, 'a-filler');
  const target = join(home, 'm-target');
  const fillerZ = join(home, 'z-filler');
  for (const dir of [fillerA, fillerZ]) {
    makeRepo(dir, 'filler: seed', { 'seed.txt': 'seed\n' });
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), 'a\nb\nc\nd\ne\nf\n');
    }
  }
  makeRepo(target, 'target: seed', {
    'target.ts': 'const t0 = 0;\nconst t1 = 1;\nconst t2 = 2;\n',
  });
  writeFileSync(join(target, 'target.ts'), 'const t0 = 0;\nconst t1 = 100;\nconst t2 = 2;\n');
  return { home, fillerA, target };
}

/** A REPO home plus an attached repo: the first project reply can predate repoGit here, which
 *  is how the group headers lost their branch (QA mf-review finding 1). */
function repoHomeFixture(work) {
  const home = join(work, 'bhome');
  const attached = join(work, 'battach');
  makeRepo(home, 'bhome: seed', { 'a.ts': 'export const a = 1;\n' });
  makeRepo(attached, 'battach: seed', { 'b.ts': 'export const b = 1;\n' });
  writeFileSync(join(home, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(attached, 'b.ts'), 'export const b = 2;\n');
  return { home, attached };
}

const card = (root, path) => `.rcard[data-root="${root}"][data-path="${path}"]`;
const navRow = (root, path) => `.right .review__navrow[data-root="${root}"][data-path="${path}"]`;

const readGroups = (page) =>
  page.$$eval('.review__group', (els) =>
    els.map((e) => ({
      name: e.querySelector('.review__groupname')?.textContent?.trim() ?? '',
      tag: e.querySelector('.repo-head__tag')?.textContent?.trim() ?? '',
      meta: e.querySelector('.review__groupmeta')?.textContent?.trim() ?? '',
      root: e.getAttribute('data-root'),
    })),
  );

const readNavGroups = (page) =>
  page.$$eval('.rnav__group', (els) =>
    els.map((e) => ({
      label: e.getAttribute('aria-label'),
      count: e.querySelector('.rnav__groupcount')?.textContent?.trim() ?? '',
    })),
  );

/** Wait until the rendered cards are exactly `want` (`root|path`, any order). */
const waitCards = (page, want, what, timeout = 15000) =>
  waitFor(
    page,
    (w) =>
      [...document.querySelectorAll('.review .rcard')]
        .map((e) => `${e.getAttribute('data-root')}|${e.getAttribute('data-path')}`)
        .sort()
        .join(',') === w,
    [...want].sort().join(','),
    what,
    timeout,
  );

/** Every open `.ctxmenu`'s rows. A disabled item's reason sits on its wrapper div, because a
 *  disabled <button> shows no title of its own (context-menu.tsx). */
const menuRows = (page) =>
  page.$$eval('.ctxmenu .ctxmenu__item', (els) =>
    els.map((e) => {
      const label = [...e.children].find(
        (c) =>
          c.tagName === 'SPAN' &&
          !c.classList.contains('ctxmenu__icon') &&
          !c.classList.contains('ctxmenu__hint'),
      );
      return {
        label: label?.textContent?.trim() ?? '',
        hint: e.querySelector('.ctxmenu__hint')?.textContent?.trim() ?? '',
        checked: e.getAttribute('aria-checked'),
        disabled: e.disabled === true,
        title: e.parentElement?.getAttribute('title') ?? '',
      };
    }),
  );

async function openChipMenu(page) {
  await page.click('.review__chip');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
}

async function pickChipRow(page, label) {
  await openChipMenu(page);
  await page
    .locator('.ctxmenu .ctxmenu__item')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${escapeRe(label)}$`) }) })
    .first()
    .click();
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
}

const waitFor = (page, fn, arg, what, timeout = 15000) =>
  page.waitForFunction(fn, arg, { timeout }).catch((e) => {
    throw new Error(`timed out waiting for ${what}: ${e?.message ?? e}`);
  });

const waitMarkable = (page, sel) =>
  waitFor(
    page,
    (s) => {
      const b = document.querySelector(`${s} .rcard__reviewed`);
      return !!b && !b.disabled;
    },
    sel,
    `${sel} to become markable`,
    20000,
  );

const pressed = (page, sel) => page.getAttribute(`${sel} .rcard__reviewed`, 'aria-pressed');

async function toggleMark(page, sel, want) {
  await waitMarkable(page, sel);
  await page.click(`${sel} .rcard__reviewed`);
  await waitFor(
    page,
    ([s, w]) => document.querySelector(`${s} .rcard__reviewed`)?.getAttribute('aria-pressed') === w,
    [sel, String(want)],
    `${sel} aria-pressed=${want}`,
  );
}

/** Poll `userData/review-marks.json` until `pred` holds (the host writes after it broadcasts). */
async function waitMarksFile(file, pred, what) {
  const deadline = Date.now() + 8000;
  let last = null;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        last = JSON.parse(readFileSync(file, 'utf8'));
        if (pred(last)) return last;
      } catch {
        /* mid-write; retry */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`review-marks.json never showed ${what}; last: ${JSON.stringify(last)}`);
}

const hasMark = (file, root, path) => (file.repos?.[root] ?? []).some((m) => m.path === path);

/** The `+` on the NEW-side row for `line` of one card (review-notes-handoff's `plusOnLine`). */
async function addNote(page, sel, line, body) {
  await waitFor(
    page,
    (s) => document.querySelector(`${s} .rline__note`)?.disabled === false,
    sel,
    `${sel} note controls to load`,
  );
  await page
    .locator(`${sel} .rline__note[data-note-side="new"][data-note-line="${line}"]`)
    .first()
    .click({ force: true });
  await page.waitForSelector('.rnote-composer__field', { state: 'visible', timeout: 8000 });
  await page.fill('.rnote-composer__field', body);
  await page.keyboard.press('Control+Enter');
  await waitFor(
    page,
    (s) => document.querySelectorAll(`${s} .rnote`).length === 1,
    sel,
    `the note on ${sel}`,
    8000,
  );
}

const setBracketedPaste = (page, sid, on) =>
  page.evaluate(
    ([s, seq]) => new Promise((r) => window.__terms[s].write(seq, r)),
    [sid, on ? '\u001b[?2004h' : '\u001b[?2004l'],
  );

const waitForSendLabel = (page, re) =>
  waitFor(
    page,
    (src) => new RegExp(src).test(document.querySelector('.review__send')?.textContent ?? ''),
    re.source,
    `the handoff control to read ${re}`,
    8000,
  );

/** Scroll the navigator until `sel` mounts (it is windowed). */
async function revealNavRow(page, sel) {
  for (let i = 0; i < 40; i++) {
    if ((await page.locator(sel).count()) > 0) return;
    await page.evaluate(() => {
      const nav = document.querySelector('.right .review__nav');
      if (nav) nav.scrollTop += Math.max(nav.clientHeight / 2, 40);
    });
    await page.waitForTimeout(250);
  }
  throw new Error(`navigator row ${sel} never mounted`);
}

const statusTexts = (page) =>
  page.$$eval('.review [role="status"]', (els) => els.map((e) => e.textContent ?? ''));

const notesOf = (root) =>
  JSON.parse(readFileSync(join(root, '.conduit', 'review-notes.json'), 'utf8')).data.notes;

runScenario('review-multi-repo', async ({ app, page, log }) => {
  const fx = fixture();
  const k = { rmb: key(fx.rmb), proto: key(fx.proto), ci: key(fx.ci), ext: key(fx.ext) };
  log(`fixture: ${fx.work}`);

  // The terminal seams (window.__terms / __termLinkProviders) and the paste spy are opt-in and
  // read at mount, so they must exist before the bundle runs: addInitScript + one reload.
  await page.addInitScript(() => {
    window.__terms = {};
    window.__termLinkProviders = {};
    window.__conduitPasteSpy = [];
  });
  await page.reload();
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  await page.evaluate(() =>
    window.agentDeck.post({ type: 'updateSettings', settings: { trackCwd: true } }),
  );
  await page.setViewportSize({ width: 1440, height: 860 });
  const userDataDir = await app.evaluate((e) => e.app.getPath('userData'));
  const marksPath = join(userDataDir, 'review-marks.json');

  const sid = await openSession(page, { path: fx.home, roots: [fx.ci] });
  await openReview(page);
  await waitFor(
    page,
    () => document.querySelectorAll('.review__group').length === 3,
    null,
    'three repo groups',
    30000,
  );
  await page.waitForSelector('.rcard .rline', { timeout: 20000 });

  // ── EARS 1 + 2: the chip, and the source trigger locked in All repos ────────────────────────
  assert((await page.locator('.review__chip').count()) === 1, 'a 3-repo session shows the chip');
  const chipLabel = await page.getAttribute('.review__chip', 'aria-label');
  const chipTitle = await page.getAttribute('.review__chip', 'title');
  assert(chipLabel === 'Review repo: All repos', `chip aria-label was "${chipLabel}"`);
  assert(chipTitle === 'Reviewing all 3 repos', `chip title was "${chipTitle}"`);
  const chipFirst = await page.evaluate(() => {
    const chip = document.querySelector('.review__head .review__chip');
    const src = document.querySelector('.review__head .review__source');
    return (
      !!chip && !!src && !!(chip.compareDocumentPosition(src) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  assert(chipFirst, 'the chip must render before the source trigger');

  const LOCK =
    'All repos reviews the working tree. Pick one repo to review a commit or compare refs.';
  const locked = await page.evaluate(() => {
    const el = document.querySelector('.review__source');
    const id = el?.getAttribute('aria-describedby');
    return {
      ariaDisabled: el?.getAttribute('aria-disabled') ?? null,
      title: el?.getAttribute('title') ?? null,
      reason: id ? (document.getElementById(id)?.textContent ?? null) : null,
    };
  });
  assert(locked.ariaDisabled === 'true', `source aria-disabled was ${locked.ariaDisabled}`);
  assert(locked.title === LOCK, `source title was "${locked.title}"`);
  assert(locked.reason === LOCK, `source aria-describedby text was "${locked.reason}"`);
  // page.click refuses an aria-disabled target; the mouse at its centre is still a real,
  // hit-tested click.
  const srcBox = await page.locator('.review__source').boundingBox();
  await page.mouse.click(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.waitForTimeout(500);
  assert(
    (await page.locator('.commit-picker').count()) === 0,
    'clicking the locked source trigger must not open the picker',
  );
  log('EARS 1/2: chip before the source; source locked with its reason; a click opens nothing ✓');

  // ── EARS 6: groups in display order, each with its tag and count ───────────────────────────
  const groups = await readGroups(page);
  log(`groups: ${JSON.stringify(groups)}`);
  const wantGroups = [
    { name: 'rmb', tag: 'Nested', meta: 'main · 2 files', root: k.rmb },
    { name: 'proto-schemas', tag: 'Nested', meta: 'main · 2 files', root: k.proto },
    { name: 'ci', tag: 'Attached', meta: 'main · 2 files', root: k.ci },
  ];
  assert(
    JSON.stringify(groups) === JSON.stringify(wantGroups),
    `groups must be ${JSON.stringify(wantGroups)}; got ${JSON.stringify(groups)}`,
  );
  const navSummary = (await page.textContent('.rnav .changes__header-summary')) ?? '';
  assert(
    navSummary.trim().startsWith('6 changes · 3 repos'),
    `navigator summary was "${navSummary}"`,
  );
  const navBefore = await readNavGroups(page);
  const wantNavBefore = [
    { label: 'rmb, 0 of 2 reviewed', count: '0/2' },
    { label: 'proto-schemas, 0 of 2 reviewed', count: '0/2' },
    { label: 'ci, 0 of 2 reviewed', count: '0/2' },
  ];
  assert(
    JSON.stringify(navBefore) === JSON.stringify(wantNavBefore),
    `navigator groups before marking: ${JSON.stringify(navBefore)}`,
  );
  log('EARS 6: rmb / proto-schemas / ci in display order, tags + r/t in the navigator ✓');

  // ── EARS 7 + 8: same-path cards, independent marks, stored under each root ─────────────────
  const readmeRoots = await page.$$eval('.rcard[data-path="README.md"]', (els) =>
    els.map((e) => e.getAttribute('data-root')),
  );
  assert(
    JSON.stringify(readmeRoots) === JSON.stringify([k.rmb, k.ci]),
    `two README.md cards with distinct data-root expected; got ${JSON.stringify(readmeRoots)}`,
  );
  const rmbReadme = card(k.rmb, 'README.md');
  const ciReadme = card(k.ci, 'README.md');

  await toggleMark(page, rmbReadme, true);
  assert(
    (await pressed(page, ciReadme)) === 'false',
    'marking rmb README.md must leave ci’s alone',
  );
  await waitFor(
    page,
    () => document.querySelector('.review__count')?.textContent?.trim() === '1 / 6 reviewed',
    null,
    'the header total to read 1 / 6 reviewed',
  );
  const navAfter = await readNavGroups(page);
  const wantNavAfter = [
    { label: 'rmb, 1 of 2 reviewed', count: '1/2' },
    { label: 'proto-schemas, 0 of 2 reviewed', count: '0/2' },
    { label: 'ci, 0 of 2 reviewed', count: '0/2' },
  ];
  assert(
    JSON.stringify(navAfter) === JSON.stringify(wantNavAfter),
    `only rmb's group count may move; got ${JSON.stringify(navAfter)}`,
  );
  await waitMarksFile(
    marksPath,
    (f) => hasMark(f, k.rmb, 'README.md') && !(k.ci in (f.repos ?? {})),
    `a README.md mark under ${k.rmb} and nothing under ${k.ci}`,
  );

  await toggleMark(page, ciReadme, true);
  assert((await pressed(page, rmbReadme)) === 'true', 'marking ci README.md must keep rmb’s');
  await waitMarksFile(
    marksPath,
    (f) => hasMark(f, k.rmb, 'README.md') && hasMark(f, k.ci, 'README.md'),
    'README.md marks under both roots',
  );
  await toggleMark(page, ciReadme, false);
  assert((await pressed(page, rmbReadme)) === 'true', 'clearing ci README.md must keep rmb’s');
  await waitMarksFile(
    marksPath,
    (f) => hasMark(f, k.rmb, 'README.md') && !(k.ci in (f.repos ?? {})),
    `the ci mark cleared and the rmb mark kept`,
  );
  const headerCount = (await page.textContent('.review__count'))?.trim();
  assert(headerCount === '1 / 6 reviewed', `header total was "${headerCount}"`);
  log('EARS 7/8: same-path cards mark independently; review-marks.json keys by repo root ✓');

  // ── The chip's menu ──────────────────────────────────────────────────────────────────────
  await openChipMenu(page);
  const chipMenu = (await menuRows(page)).map(({ label, hint, checked }) => ({
    label,
    hint,
    checked,
  }));
  log(`chip menu: ${JSON.stringify(chipMenu)}`);
  assert(
    chipMenu.length === 4 && chipMenu[0].label === 'All repos' && chipMenu[0].checked === 'true',
    `the first row must be a checked All repos; got ${JSON.stringify(chipMenu)}`,
  );
  const repoRows = chipMenu.slice(1).map(({ label, hint }) => ({ label, hint }));
  const wantRepoRows = [
    { label: 'rmb', hint: '2 files' },
    { label: 'proto-schemas', hint: '2 files' },
    { label: 'ci', hint: '2 files' },
  ];
  assert(
    JSON.stringify(repoRows) === JSON.stringify(wantRepoRows),
    `chip repo rows: ${JSON.stringify(repoRows)}`,
  );
  await closeMenu(page);

  // ── EARS 3 + Gherkin: narrow to proto, then Staged ─────────────────────────────────────────
  await pickChipRow(page, 'proto-schemas');
  await waitFor(
    page,
    () =>
      document.querySelectorAll('.review__group').length === 0 &&
      document.querySelector('.review__chip')?.getAttribute('aria-label') ===
        'Review repo: proto-schemas',
    null,
    'Review narrowed to proto-schemas',
  );
  const narrowedTitle = await page.getAttribute('.review__chip', 'title');
  assert(
    narrowedTitle === 'rmb-ws/vendor/proto-schemas',
    `narrowed chip title was "${narrowedTitle}"`,
  );
  assert(
    (await page.getAttribute('.review__source', 'aria-disabled')) === null,
    'the source trigger unlocks once one repo is picked',
  );
  await waitCards(
    page,
    [`${k.proto}|room.proto`, `${k.proto}|staged.proto`],
    'only proto’s two files',
  );

  await page.locator('.review__scope').getByRole('radio', { name: 'Staged', exact: true }).click();
  await waitCards(page, [`${k.proto}|staged.proto`], 'only proto’s staged file');
  assert((await page.locator('.review__group').count()) === 0, 'a narrowed Review has no headers');
  assert(
    (await page.getAttribute('.review__chip', 'aria-label')) === 'Review repo: proto-schemas',
    'the chip must still read proto-schemas after a scope change',
  );
  log('EARS 3: narrowed to proto — its files only, no headers; Staged keeps the repo ✓');

  // The picker is scoped to proto's history.
  await page.click('.review__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  await waitFor(
    page,
    () => document.querySelectorAll('.commit-picker__row .commit-picker__sha').length > 0,
    null,
    'the picker to list commits',
  );
  const subjects = await page.$$eval('.commit-picker__row .commit-picker__subject', (els) =>
    els.map((e) => e.textContent?.trim() ?? ''),
  );
  log(`picker subjects: ${JSON.stringify(subjects)}`);
  assert(subjects.includes(SUBJECT.proto), `the picker must list "${SUBJECT.proto}"`);
  assert(
    !subjects.includes(SUBJECT.rmb) && !subjects.includes(SUBJECT.ci),
    `the picker must not list another repo's commits; got ${JSON.stringify(subjects)}`,
  );

  // EARS 4 — asserted on the host's reply: `git:commitDiffResult` echoes the request's `root`
  // (main.ts), so it is the root the renderer asked for. No outgoing-post tap exists in the harness.
  await page.evaluate(() => {
    window.__cdr = [];
    if (window.__cdrTapped) return;
    window.__cdrTapped = true;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'git:commitDiffResult')
        window.__cdr.push({ sha: m.sha, root: m.root ?? null, error: m.error ?? null });
    });
  });
  await page
    .locator('.commit-picker__list .commit-picker__row', { hasText: SUBJECT.proto })
    .first()
    .click();
  const cdr = await waitFor(
    page,
    () => (window.__cdr.length > 0 ? window.__cdr[window.__cdr.length - 1] : null),
    null,
    'a git:commitDiffResult',
  ).then((h) => h.jsonValue());
  log(`commitDiff reply: ${JSON.stringify(cdr)}`);
  assert(
    cdr.root !== null && key(cdr.root) === k.proto && cdr.error === null,
    `the commit diff must be read from proto (${k.proto}); got ${JSON.stringify(cdr)}`,
  );
  await waitCards(page, [`${k.proto}|room.proto`], 'the proto commit’s one file');
  const commitLabel = (await page.textContent('.review__source .gh__reffilter-label')) ?? '';
  assert(commitLabel.includes(SUBJECT.proto), `source label was "${commitLabel}"`);
  log('EARS 4: the picked commit is read from proto’s root ✓');

  // EARS 5: All repos puts the working tree back, every group with it.
  await pickChipRow(page, 'All repos');
  await waitFor(
    page,
    () => document.querySelectorAll('.review__group').length === 3,
    null,
    'all three groups back',
  );
  const backLabel = (await page.textContent('.review__source .gh__reffilter-label'))?.trim();
  assert(backLabel === 'Working tree', `source label after All repos was "${backLabel}"`);
  assert(
    (await page.getAttribute('.review__chip', 'aria-label')) === 'Review repo: All repos',
    'the chip must read All repos again',
  );
  assert(
    (await page.getAttribute('.review__source', 'aria-disabled')) === 'true',
    'the source trigger locks again in All repos',
  );
  log('EARS 5 / Gherkin: All repos → Working tree and every group back ✓');

  // ── EARS 10: grouped handoff into the live terminal ────────────────────────────────────────
  await page.waitForSelector(card(k.rmb, 'README.md'), { timeout: 15000 });
  await addNote(page, rmbReadme, 3, 'say what a room is');
  await addNote(page, ciReadme, 3, 'list the repos');
  await waitForSendLabel(page, /Copy as markdown/);
  await setBracketedPaste(page, sid, true);
  await waitForSendLabel(page, /Send to agent \(2\)/);
  await page.click('.review__send');
  const paste = await waitFor(
    page,
    () => (window.__conduitPasteSpy.length > 0 ? window.__conduitPasteSpy[0] : null),
    null,
    'the handoff paste',
    8000,
  ).then((h) => h.jsonValue());
  log(`handoff:\n${paste.text}`);
  assert(paste.sessionId === sid, `the handoff must target ${sid}; got ${paste.sessionId}`);
  assert(
    paste.text.startsWith('Review notes on 2 files in 2 repos ('),
    `unexpected handoff header:\n${paste.text}`,
  );
  const lines = paste.text.split('\n');
  assert(lines.includes('## rmb') && lines.includes('## ci'), 'one ## section per repo');
  assert(!lines.includes('## proto-schemas'), 'a repo without notes gets no section');
  assert(lines.includes('### rmb/README.md'), 'a nested repo’s path is relative to home');
  const attachedHeading = new RegExp(`^### ${escapeRe(fwd(fx.ci))}/README\\.md$`, 'im');
  assert(attachedHeading.test(paste.text), 'an attached repo’s path is absolute, forward-slashed');
  assert(lines.indexOf('## rmb') < lines.indexOf('## ci'), 'sections follow the display order');
  await waitForSendLabel(page, /Send to agent \(0\)/);
  await page.waitForTimeout(600);
  for (const root of [fx.rmb, fx.ci]) {
    const notes = notesOf(root);
    assert(
      notes.length === 1 && typeof notes[0].sentAt === 'string',
      `${root}/.conduit/review-notes.json must record the note as sent; got ${JSON.stringify(notes)}`,
    );
  }
  assert(
    !existsSync(join(fx.proto, '.conduit', 'review-notes.json')),
    'a repo with no notes gets no notes file',
  );
  await setBracketedPaste(page, sid, false);
  // cmd has no bracketed paste, so the pasted text is sitting on (and partly ran at) its prompt;
  // Esc clears the line before anything else is typed there.
  await page.evaluate(
    (s) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: '\u001b' }),
    sid,
  );
  log('EARS 10: ## rmb / ## ci, home-relative and absolute paths, both notes files stamped sent ✓');

  // ── EARS 9: bulk rules ───────────────────────────────────────────────────────────────────
  await page.click('.review__barmore');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const barDiscard = (await menuRows(page)).find((r) => r.label.startsWith('Discard all changes'));
  assert(!!barDiscard, 'the bar ··· menu must carry Discard all changes…');
  assert(barDiscard.disabled, 'Discard all changes… must be disabled in All repos');
  assert(
    barDiscard.title === 'Pick one repo to discard its changes',
    `bar discard title was "${barDiscard.title}"`,
  );
  await closeMenu(page);

  await page.click('.rnav .changes__kebab');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const kebab = await menuRows(page);
  log(`nav kebab: ${JSON.stringify(kebab)}`);
  const byLabel = Object.fromEntries(kebab.map((r) => [r.label, r]));
  assert(
    byLabel['Stage all'] && !byLabel['Stage all'].disabled,
    'the kebab’s Stage all fans out, so it stays enabled',
  );
  assert(
    byLabel['Unstage all'] && !byLabel['Unstage all'].disabled,
    'the kebab’s Unstage all fans out (proto has a staged file), so it stays enabled',
  );
  for (const label of ['Stash changes', 'Pop stash', 'Discard all changes']) {
    assert(byLabel[label]?.disabled === true, `the kebab’s ${label} must be disabled`);
    assert(
      byLabel[label].title === 'Pick one repo first',
      `the kebab’s ${label} title was "${byLabel[label].title}"`,
    );
  }
  await closeMenu(page);

  const stageTitle = await page.getAttribute('.review__stageall', 'title');
  assert(
    stageTitle === 'Stage every changed file in 3 repos',
    `Stage all title was "${stageTitle}"`,
  );
  await page.click('.review__stageall');
  const wantStaged = {
    [fx.rmb]: ['README.md', 'src/bus.ts'],
    [fx.proto]: ['room.proto', 'staged.proto'],
    [fx.ci]: ['README.md', 'pipeline.yml'],
  };
  const deadline = Date.now() + 20000;
  let cached = {};
  for (;;) {
    cached = Object.fromEntries(
      Object.keys(wantStaged).map((r) => [
        r,
        git(r, 'diff', '--cached', '--name-only').split('\n'),
      ]),
    );
    if (Object.entries(wantStaged).every(([r, fs]) => fs.every((f) => cached[r].includes(f))))
      break;
    if (Date.now() > deadline)
      throw new Error(`Stage all did not stage every repo: ${JSON.stringify(cached)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  log('EARS 9: Stage all staged all three repos; discard / stash / pop disabled with a reason ✓');
  // Bulk actions act on exactly the files Review lists; its own notes file is never listed.
  for (const r of [fx.rmb, fx.ci]) {
    assert(
      !cached[r].includes('.conduit/review-notes.json'),
      `Stage all must not stage ${r}'s review notes: ${JSON.stringify(cached[r])}`,
    );
  }
  log('Stage all left each repo’s .conduit/review-notes.json unstaged ✓');
  await waitFor(
    page,
    () => document.querySelector('.review__stageall')?.getAttribute('aria-disabled') === 'true',
    null,
    'Stage all to lock once nothing is left unstaged',
  );
  const lockedStageTitle = await page.getAttribute('.review__stageall', 'title');
  assert(
    lockedStageTitle === 'Nothing left to stage in any repo',
    `locked Stage all title was "${lockedStageTitle}"`,
  );
  log('All repos, nothing unstaged: Stage all is locked with its reason ✓');

  // ── EARS 12: the narrowed repo leaves the session ──────────────────────────────────────────
  await pickChipRow(page, 'ci');
  await waitFor(
    page,
    () =>
      document.querySelectorAll('.review__group').length === 0 &&
      document.querySelector('.review__chip')?.getAttribute('aria-label') === 'Review repo: ci',
    null,
    'Review narrowed to ci',
  );

  // Narrowed kebab, staged-then-edited: git reports README.md staged AND unstaged, and that is
  // ci's only unstaged side. Review shows one card for it, but Stage all must stay enabled.
  writeFileSync(join(fx.ci, 'README.md'), '# ci\n\nPipelines for every repo, edited again.\n');
  assert(
    git(fx.ci, 'diff', '--name-only').split('\n').includes('README.md') &&
      git(fx.ci, 'diff', '--cached', '--name-only').split('\n').includes('README.md'),
    'ci/README.md must be staged and edited again',
  );
  await page.click('.rnav .changes__refresh');
  const mmDeadline = Date.now() + 15000;
  let mmKebab = [];
  for (;;) {
    await page.click('.rnav .changes__kebab');
    await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
    mmKebab = await menuRows(page);
    await closeMenu(page);
    if (mmKebab.find((r) => r.label === 'Stage all')?.disabled === false) break;
    if (Date.now() > mmDeadline)
      throw new Error(`narrowed kebab Stage all stayed disabled: ${JSON.stringify(mmKebab)}`);
    await page.waitForTimeout(300);
  }
  assert(
    mmKebab.find((r) => r.label === 'Unstage all')?.disabled === false,
    `narrowed kebab Unstage all must be enabled: ${JSON.stringify(mmKebab)}`,
  );
  log('narrowed kebab: a staged-then-edited file keeps Stage all enabled ✓');

  // Narrowed Discard all counts and discards the two files Review lists, never the notes file.
  const ciNotesBefore = notesOf(fx.ci).length;
  await page.click('.rnav .changes__kebab');
  await page
    .locator('.ctxmenu [role="menuitem"]', { hasText: 'Discard all changes' })
    .click({ timeout: 5000 });
  await page.waitForSelector('.confirm', { state: 'visible', timeout: 5000 });
  const discardMsg = await page.textContent('.confirm .confirm__msg');
  assert(
    discardMsg ===
      'Discard all 2 changes in ci? Untracked files are deleted too. This cannot be undone.',
    `the narrowed Discard all confirm must count the 2 listed files: ${JSON.stringify(discardMsg)}`,
  );
  await page.locator('.confirm .confirm__actions button', { hasText: 'Discard all' }).click();
  const discardDeadline = Date.now() + 15000;
  for (;;) {
    const st = git(fx.ci, 'status', '--porcelain', '-uall');
    if (st === '?? .conduit/review-notes.json') break;
    if (Date.now() > discardDeadline)
      throw new Error(`Discard all left ci as ${JSON.stringify(st)}`);
    await page.waitForTimeout(300);
  }
  assert(
    notesOf(fx.ci).length === ciNotesBefore,
    'Discard all must keep ci’s review notes file and its notes',
  );
  log('narrowed Discard all: "2 changes in ci", ci clean, its review notes kept ✓');

  await page.evaluate(
    ([s, p]) => window.agentDeck.post({ type: 'session:removeRoot', sessionId: s, path: p }),
    [sid, fwd(fx.ci)],
  );
  await waitFor(
    page,
    () =>
      [...document.querySelectorAll('.review [role="status"]')].some((e) =>
        /is no longer in this session/.test(e.textContent ?? ''),
      ),
    null,
    'the repo-left announcement',
  );
  await waitFor(
    page,
    () => document.querySelectorAll('.review__group').length === 2,
    null,
    'the remaining two groups',
  );
  const leftGroups = (await readGroups(page)).map((g) => g.name);
  assert(
    JSON.stringify(leftGroups) === JSON.stringify(['rmb', 'proto-schemas']),
    `groups after ci left: ${JSON.stringify(leftGroups)}`,
  );
  assert(
    (await page.getAttribute('.review__chip', 'aria-label')) === 'Review repo: All repos',
    'Review must fall back to All repos',
  );
  const leftText = (await statusTexts(page)).find((t) => /is no longer in this session/.test(t));
  log(`EARS 12: "${leftText}" — fell back to All repos ✓`);

  // ── EARS 13: a terminal sha link into a repo outside the session ──────────────────────────
  // shell:cmd has no injected cwd hook (src/cwd-reporting.ts), so give its prompt the OSC 9;9
  // report Windows Terminal documents for cmd; the host parses it passively.
  await page.evaluate(
    ([s, dir]) => {
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: 'prompt $E]9;9;$P$E\\$P$G\r',
      });
      window.agentDeck.post({ type: 'term:input', sessionId: s, data: `cd /d "${dir}"\r` });
    },
    [sid, fx.ext],
  );
  await waitFor(
    page,
    ([s, want]) => {
      const sess = (window.__sessions || []).find((x) => x.id === s);
      return !!sess && (sess.cwd || '').replace(/\\/g, '/').toLowerCase() === want;
    },
    [sid, k.ext],
    'the session cwd to move into ext (cmd prompt OSC 9;9)',
  );
  const validate = () =>
    page.evaluate(
      ({ s, tok }) =>
        new Promise((resolve) => {
          window.agentDeck.subscribe((m) => {
            if (m.type === 'validateCommitsResult' && m.sessionId === s)
              resolve({ commit: m.results?.[0]?.commit ?? null, root: m.root ?? null });
          });
          window.agentDeck.post({ type: 'validateCommits', sessionId: s, tokens: [tok] });
          setTimeout(() => resolve({ commit: null, root: null }), 3000);
        }),
      { s: sid, tok: fx.extSha },
    );
  let validated = { commit: null, root: null };
  for (let i = 0; i < 12 && validated.commit !== fx.extSha; i++) {
    validated = await validate();
    if (validated.commit !== fx.extSha) await page.waitForTimeout(500);
  }
  assert(
    validated.commit === fx.extSha && key(validated.root ?? '') === k.ext,
    `ext's sha must validate against ext; got ${JSON.stringify(validated)}`,
  );
  await page.evaluate(
    ({ s, sha }) => new Promise((r) => window.__terms[s].write(`\r\nBuilt ${sha}\r\n`, r)),
    { s: sid, sha: fx.extSha },
  );
  let routed = { error: 'not attempted' };
  for (let attempt = 0; attempt < 6; attempt++) {
    routed = await page.evaluate(
      ({ s, sha }) =>
        new Promise((resolve) => {
          const buf = window.__terms[s].buffer.active;
          const probe = sha.slice(0, 12);
          let row = -1;
          for (let y = 0; y < buf.length; y++)
            if (buf.getLine(y)?.translateToString(true).includes(probe)) row = y;
          if (row < 0) return resolve({ error: 'sha not in buffer' });
          const provider = window.__termLinkProviders[s];
          if (!provider) return resolve({ error: 'no link provider' });
          let done = false;
          provider.provideLinks(row + 1, (links) => {
            if (done) return;
            done = true;
            const link = (links || []).find((l) => l.text === sha);
            if (!link) return resolve({ error: 'no commit link' });
            link.activate(new MouseEvent('click'), link.text);
            resolve({ ok: true });
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              resolve({ error: 'provideLinks timeout' });
            }
          }, 4000);
        }),
      { s: sid, sha: fx.extSha },
    );
    if (routed.ok || routed.error !== 'sha not in buffer') break;
    await page.waitForTimeout(400);
  }
  assert(routed.ok === true, `the ext commit link must activate; got ${JSON.stringify(routed)}`);
  await waitCards(page, [`${k.ext}|ext-only.txt`], 'the ext commit’s file', 20000);
  const extLabel = (await page.textContent('.review__source')) ?? '';
  assert(
    extLabel.includes(fx.extSha.slice(0, 7)),
    `the source must name the ext commit; got "${extLabel}"`,
  );
  assert(
    !(await statusTexts(page)).some((t) => /^ext is no longer in this session/.test(t)),
    'an out-of-set commit must not fall back',
  );
  log('EARS 13: a terminal sha link into ext (outside the session) shows that commit ✓');

  // ── EARS 14: a note glyph in a nested repo's file lands on its card ────────────────────────
  const gx = glyphFixture(fx.work);
  const g = { a: key(gx.fillerA), m: key(gx.target) };
  await openSession(page, { path: gx.home });
  await openReview(page);
  await waitFor(
    page,
    (a) => document.querySelector('.review__group')?.getAttribute('data-root') === a,
    g.a,
    'the glyph fixture’s groups',
    30000,
  );
  const targetRow = navRow(g.m, 'target.ts');
  await revealNavRow(page, targetRow);
  await page.locator(`${targetRow} .review__navbtn`).click();
  const targetCard = card(g.m, 'target.ts');
  await page.waitForSelector(`${targetCard} .rline`, { timeout: 20000 });
  await addNote(page, targetCard, 2, 'why 100');
  await page.click(`${targetCard} .rcard__open`);
  await waitFor(
    page,
    () =>
      (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith('target.ts')),
    null,
    'target.ts open in the editor',
    20000,
  );
  // Park Review at the top so the landing has somewhere to travel.
  await page.locator('.tab', { hasText: 'Review Changes' }).first().click();
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  await page.evaluate(() => {
    const el = document.querySelector('.review__scroll');
    if (el) el.scrollTop = 0;
  });
  await waitFor(
    page,
    (a) =>
      document.querySelector('.right .review__navrow--active')?.getAttribute('data-root') === a,
    g.a,
    'Review parked on the first filler repo',
  );
  await page.locator('.tab', { hasText: 'target.ts' }).first().click();
  await page.waitForSelector('.review', { state: 'hidden', timeout: 10000 });
  const glyph = page.locator('.monaco-editor .ndec').first();
  await glyph.waitFor({ state: 'attached', timeout: 20000 });
  const gBox = await glyph.boundingBox();
  assert(gBox !== null, 'the note glyph must have a box to click');
  await page.mouse.click(
    gBox.x + Math.max(gBox.width / 2, 2),
    gBox.y + Math.max(gBox.height / 2, 2),
  );
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  await waitFor(
    page,
    ([sel, m]) => {
      const c = document.querySelector(sel);
      const sc = document.querySelector('.review__scroll');
      const active = document.querySelector('.right .review__navrow--active');
      if (!c || !sc || !active) return false;
      const cr = c.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      return (
        sc.scrollTop > 0 &&
        cr.top >= sr.top - 1 &&
        cr.top < sr.bottom &&
        active.getAttribute('data-root') === m &&
        active.getAttribute('data-path') === 'target.ts'
      );
    },
    [targetCard, g.m],
    'Review to land on m-target/target.ts',
  );
  const landed = (await statusTexts(page)).find((t) => t.startsWith('Opened the note'));
  assert(
    landed === 'Opened the note on line 2 of target.ts',
    `the landing announcement was "${landed}"`,
  );
  log('EARS 14: the glyph in a nested repo’s file lands Review on that card ✓');

  // ── Group headers carry the branch on first open with a REPO home (QA finding 1) ──────────
  // No refresh is clicked: the branch must arrive with the session's live repoGit.
  const bx = repoHomeFixture(fx.work);
  await openSession(page, { path: bx.home, roots: [bx.attached] });
  await openReview(page);
  await waitFor(
    page,
    () => {
      const metas = [...document.querySelectorAll('.review__group .review__groupmeta')].map(
        (e) => e.textContent?.trim() ?? '',
      );
      return metas.length === 2 && metas.every((m) => m === 'main · 1 file');
    },
    null,
    'both repo-home group headers to read "main · 1 file" without a refresh',
    20000,
  );
  log('repo home + attached: both group headers read "main · 1 file" on first open ✓');

  // ── EARS 1 (negative): a single-repo session has no chip and no groups ─────────────────────
  await openSession(page, { path: fx.solo });
  await openReview(page);
  await page.waitForSelector('.review .rcard[data-path="app.ts"] .rline', { timeout: 20000 });
  const single = await page.evaluate(() => ({
    chip: document.querySelectorAll('.review__chip').length,
    groups: document.querySelectorAll('.review__group').length,
    navGroups: document.querySelectorAll('.rnav__group').length,
    sourceDisabled:
      document.querySelector('.review__source')?.getAttribute('aria-disabled') ?? null,
  }));
  assert(
    single.chip === 0 && single.groups === 0 && single.navGroups === 0,
    `a single-repo Review must have no chip or groups; got ${JSON.stringify(single)}`,
  );
  assert(single.sourceDisabled === null, 'a single-repo source trigger is never locked');
  log('EARS 1: a single-repo session shows no chip, no group headers, an unlocked source ✓');
});
