/**
 * Changes tab per repo (real-app smoke): a home repo plus an attached reference repo in one
 * session. docs/specs/archive/2026-09-23-mf-changes.md §7.3 Gherkin step for step, then AC2, AC3 (incl.
 * a relaunch on the same userData), AC4, AC8, AC9 and locked L11. Repo detection, per-repo GitInfo
 * and the `repoChanges` fan-out are host-side, so only the real app can prove any of it.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeRow, installTabHelpers } from './changes-fixture.mjs';
import {
  assert,
  closeApp,
  launchApp,
  makeLog,
  openChangesTab,
  openHistory,
  openSession,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

const NAME = 'changes-multi-repo';
const log = makeLog(NAME);

if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only (non-win32 platform)`);
  process.exit(0);
}

const PER_REPO_TITLE = 'Works on one repo. Right-click a repo header, or switch to Active repo.';
const PER_REPO_ITEMS = ['Stash changes', 'Pop stash', 'Discard all changes'];

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
// --no-optional-locks: a polling status must not take index.lock out from under the app's own git.
const porcelain = (dir) => git(dir, '--no-optional-locks', 'status', '--porcelain');
const head = (dir) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
const fwd = (p) => p.replace(/\\/g, '/');

function makeRepo(dir, subject) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@conduit.test');
  git(dir, 'config', 'user.name', 'e2e');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'base.txt'), `${subject}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', subject);
}

const work = mkdtempSync(join(tmpdir(), 'conduit-cmr-'));
const home = join(work, 'home');
const ref = join(work, 'ref');
const third = join(work, 'third');
const plain = join(work, 'plain');
const solo = join(work, 'solo');
makeRepo(home, 'home-subject');
writeFileSync(join(home, 'a.txt'), 'a1\n');
git(home, 'add', 'a.txt');
git(home, 'commit', '-qm', 'home-a');
writeFileSync(join(home, 'a.txt'), 'a2\n');
makeRepo(ref, 'ref-subject');
git(ref, 'branch', 'feature');
// A new file: once unstaged it is untracked, which the switch's dirty gate ignores (-uno), so the
// Gherkin's branch switch can follow its unstage without a commit in between.
writeFileSync(join(ref, 'b.txt'), 'b\n');
git(ref, 'add', 'b.txt');
makeRepo(third, 'third-subject');
mkdirSync(plain, { recursive: true });
writeFileSync(join(plain, 'notes.txt'), 'not a repo\n');
makeRepo(solo, 'solo-subject');

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-cmr-ud-'));

const sessionOf = (page, id) =>
  page.evaluate((sid) => (window.__sessions || []).find((s) => s.id === sid) ?? null, id);

async function waitFor(page, fn, arg, what, timeout = 15000) {
  const ok = await page.waitForFunction(fn, arg, { timeout }).then(
    () => true,
    () => false,
  );
  assert(ok, `timed out waiting for ${what}`);
}

const readHeads = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.repo-head'), (h) => {
      const list = h.nextElementSibling?.classList.contains('repo-head__list')
        ? h.nextElementSibling
        : null;
      return {
        name: h.querySelector('.repo-head__name')?.textContent ?? '',
        tag: h.querySelector('.repo-head__tag')?.textContent ?? null,
        chip: h.querySelector('.branch-chip .branch-chip__label')?.textContent ?? '',
        picker: !!h.querySelector('.repo-head__picker'),
        files: list ? Array.from(list.querySelectorAll('.change__file'), (f) => f.textContent) : [],
      };
    }),
  );

const headIs = (page, want, what) =>
  waitFor(
    page,
    (w) =>
      JSON.stringify(
        Array.from(document.querySelectorAll('.repo-head'), (h) => {
          const list = h.nextElementSibling?.classList.contains('repo-head__list')
            ? h.nextElementSibling
            : null;
          return {
            name: h.querySelector('.repo-head__name')?.textContent ?? '',
            files: list
              ? Array.from(list.querySelectorAll('.change__file'), (f) => f.textContent)
              : [],
          };
        }),
      ) === w,
    JSON.stringify(want),
    `${what}: heads ${JSON.stringify(want)}`,
  );

/** The open .ctxmenu's items by label → { disabled, title } (title sits on the item's wrapper). */
const readMenu = (page) =>
  page.evaluate(() => {
    const menu = document.querySelector('.ctxmenu');
    return Object.fromEntries(
      Array.from(menu?.querySelectorAll('.ctxmenu__item') ?? [], (b) => [
        b.textContent?.trim() ?? '',
        {
          disabled: b.disabled && b.getAttribute('aria-disabled') === 'true',
          title: b.parentElement?.getAttribute('title') ?? '',
        },
      ]),
    );
  });

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
}

async function untilPorcelain(dir, want, what) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (porcelain(dir) === want) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(false, `${what}: want ${JSON.stringify(want)}, got ${JSON.stringify(porcelain(dir))}`);
}

/** Every chevron's aria-controls names an element that is in the DOM (N-2). */
async function assertAriaControlsResolve(page, what) {
  const heads = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.repo-head [aria-controls]'), (el) => {
      const id = el.getAttribute('aria-controls');
      return { id, found: !!(id && document.getElementById(id)) };
    }),
  );
  assert(
    heads.every((h) => h.found),
    `${what}: every aria-controls names a rendered list: ${JSON.stringify(heads)}`,
  );
  return heads.length;
}

async function pickBulk(page, label) {
  await page.click('.changes__kebab');
  await page
    .locator('.ctxmenu [role="menuitem"]')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .click({ timeout: 5000 });
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
}

async function setView(page, label) {
  await page.click('.changes__kebab');
  await page
    .locator('.ctxmenu [role="menuitemradio"]', { hasText: label })
    .click({ timeout: 5000 });
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
}

const emptyCopy = (page) =>
  page.evaluate(() => ({
    title: document.querySelector('.rightpane .emptystate__title')?.textContent ?? null,
    hint: document.querySelector('.rightpane .emptystate__hint')?.textContent ?? null,
  }));

async function expectEmpty(page, title, hint, what) {
  await waitFor(
    page,
    ([t, h]) =>
      document.querySelector('.rightpane .emptystate__title')?.textContent === t &&
      document.querySelector('.rightpane .emptystate__hint')?.textContent === h,
    [title, hint],
    `${what}: "${title}" / "${hint}"`,
  ).catch(async (e) => {
    log('empty state is', JSON.stringify(await emptyCopy(page)));
    throw e;
  });
}

async function runFirstLaunch(page) {
  await tapBridge(page);
  await installTabHelpers(page);
  const sid = await openSession(page, { path: home, roots: [ref] });
  await waitFor(
    page,
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      const g = Object.values(s?.repoGit ?? {});
      return s?.repos?.length === 2 && g.length === 2 && g.every((x) => x.kind === 'branch');
    },
    sid,
    'two repos detected, each with its GitInfo',
    25000,
  );
  await openChangesTab(page);
  await installTabHelpers(page);

  const tabRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tabbar-wrap')];
    return {
      rows: rows.length,
      git: rows.flatMap((r) =>
        [
          ...r.querySelectorAll(
            '.git-indicator, [class*="git-indicator"], .repo-picker, [class*="repo-picker"], .branch-chip, .repo-head, .changes__review',
          ),
        ].map((el) => el.className),
      ),
    };
  });
  assert(tabRow.rows > 0, 'the terminal tab row (.tabbar-wrap) must render');
  assert(tabRow.git.length === 0, `tab row holds no git controls: ${JSON.stringify(tabRow.git)}`);
  log('tab row rendered, no git controls ✓');

  await headIs(
    page,
    [
      { name: 'home', files: ['a.txt'] },
      { name: 'ref', files: ['b.txt'] },
    ],
    'All view lists each repo',
  );
  const heads = await readHeads(page);
  assert(
    JSON.stringify(heads.map((h) => [h.name, h.tag, h.chip])) ===
      JSON.stringify([
        ['home', 'Home', 'main'],
        ['ref', 'Attached', 'main'],
      ]),
    `heads read home·Home·main then ref·Attached·main: ${JSON.stringify(heads)}`,
  );
  log('heads: home · Home · main, ref · Attached · main, each listing only its own file ✓');

  const header = await page.evaluate(() => ({
    title: document.querySelector('.changes__header-summary')?.getAttribute('title'),
    count: document.querySelector('.changes__header-count')?.textContent,
    badge: document.querySelector('.rtab .rtab__badge')?.textContent ?? null,
  }));
  assert(
    header.count === '2 changes · 2 repos' && header.title === '2 changes · 2 repos +2 -1',
    `AC2 header reads "2 changes · 2 repos +2 -1": ${JSON.stringify(header)}`,
  );
  assert(header.badge === '2', `AC2 Changes badge equals N=2: ${JSON.stringify(header)}`);
  log('AC2: header "2 changes · 2 repos +2 -1", badge 2 ✓');

  await page.click('.changes__kebab');
  await page.waitForSelector('.ctxmenu [role="menuitemradio"]', { state: 'visible' });
  const headerMenu = await readMenu(page);
  await closeMenu(page);
  assert(
    PER_REPO_ITEMS.every(
      (l) => headerMenu[l]?.disabled === true && headerMenu[l]?.title === PER_REPO_TITLE,
    ),
    `L11: header ${PER_REPO_ITEMS.join(' / ')} disabled with the per-repo title: ${JSON.stringify(headerMenu)}`,
  );
  const refHead = page.locator('.repo-head', {
    has: page.locator('.repo-head__name').getByText('ref', { exact: true }),
  });
  await refHead.locator('.repo-head__name').click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const refMenu = await readMenu(page);
  await closeMenu(page);
  assert(
    PER_REPO_ITEMS.every((l) => refMenu[l] && refMenu[l].disabled === false),
    `L11: the ref head's menu offers ${PER_REPO_ITEMS.join(' / ')} enabled: ${JSON.stringify(refMenu)}`,
  );
  log('L11: header Stash/Pop/Discard disabled + titled; ref head menu has them enabled ✓');

  const homeBefore = porcelain(home);
  assert(porcelain(ref) === 'A  b.txt\n', `ref starts with b.txt staged: ${porcelain(ref)}`);
  const staged = await changeRow(page, 'Staged', 'b.txt', { repo: 'ref' });
  await staged.hover();
  await staged.getByRole('button', { name: 'Unstage' }).click();
  await changeRow(page, 'Changes', 'b.txt', { repo: 'ref' });
  assert(
    porcelain(ref) === '?? b.txt\n',
    `ref shows b.txt unstaged: ${JSON.stringify(porcelain(ref))}`,
  );
  assert(
    porcelain(home) === homeBefore,
    `home status untouched: ${JSON.stringify(porcelain(home))}`,
  );
  log('unstaged b.txt under ref: ref "?? b.txt", home byte-identical ✓');

  assert(porcelain(home) === ' M a.txt\n', `home starts with a.txt modified: ${porcelain(home)}`);
  await pickBulk(page, 'Stage all');
  await untilPorcelain(home, 'M  a.txt\n', 'All-view Stage all stages home');
  await untilPorcelain(ref, 'A  b.txt\n', 'All-view Stage all stages ref');
  log('All view: header Stage all → home "M  a.txt", ref "A  b.txt" ✓');
  // Unstage all is enabled from the rendered list, which lands after the disk does.
  await waitFor(
    page,
    () =>
      Array.from(document.querySelectorAll('.repo-head__list')).filter((l) =>
        Array.from(l.querySelectorAll('.changes__section'), (s) => s.textContent ?? '').some((t) =>
          t.startsWith('Staged'),
        ),
      ).length === 2,
    null,
    'both repos list a Staged section',
  );
  await pickBulk(page, 'Unstage all');
  await untilPorcelain(home, ' M a.txt\n', 'All-view Unstage all unstages home');
  await untilPorcelain(ref, '?? b.txt\n', 'All-view Unstage all unstages ref');
  await headIs(
    page,
    [
      { name: 'home', files: ['a.txt'] },
      { name: 'ref', files: ['b.txt'] },
    ],
    'the list follows the fan-out',
  );
  log('All view: header Unstage all → home " M a.txt", ref "?? b.txt" ✓');

  await setView(page, 'Active repo');
  await waitFor(
    page,
    () =>
      document.querySelectorAll('.repo-head').length === 1 &&
      !!document.querySelector('.repo-head .repo-head__picker'),
    null,
    'Active view: one head with a picker',
  );
  await page.click('.repo-head .repo-head__picker');
  await page.locator('.repo-picker-menu').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.repo-picker-menu__row', { hasText: 'ref' }).first().click();
  await waitFor(
    page,
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return (
        s?.repoPinned === true && (s.activeRepoRoot ?? '').replace(/\\/g, '/').endsWith('/ref')
      );
    },
    sid,
    'picking ref pins it',
  );
  await headIs(page, [{ name: 'ref', files: ['b.txt'] }], 'Active view swapped to ref');
  log('AC3: Active view, pick ref → repoPinned, list swaps to ref ✓');

  await page.click('.repo-head .repo-head__picker');
  await page.locator('.repo-picker-menu').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.repo-picker-menu [role="menuitem"]', { hasText: 'Show all repos' }).click();
  await headIs(
    page,
    [
      { name: 'home', files: ['a.txt'] },
      { name: 'ref', files: ['b.txt'] },
    ],
    'Show all repos returns both heads',
  );
  await waitFor(
    page,
    (id) => (window.__sessions || []).find((x) => x.id === id)?.repoPinned === false,
    sid,
    'Show all repos unpins (D15)',
  );
  log('AC3: Show all repos → two heads, repoPinned false ✓');

  await setView(page, 'Active repo');
  await page.click('.repo-head .repo-head__picker');
  await page.locator('.repo-picker-menu').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.repo-picker-menu__row', { hasText: 'ref' }).first().click();
  await waitFor(
    page,
    (id) => (window.__sessions || []).find((x) => x.id === id)?.repoPinned === true,
    sid,
    'picking ref pins it again',
  );
  await page.locator('.footbtn[title^="Settings"]').click();
  // A select opened while the modal is still popping in is closed again at once.
  await waitFor(
    page,
    () =>
      document.querySelector('.modal.settings')?.parentElement?.getAnimations({ subtree: true })
        .length === 0,
    null,
    'the Settings modal finished opening',
  );
  await page.click('.modal.settings .selectfield[aria-label="Changes view"]');
  await page.locator('.ctxmenu [role="menuitem"]', { hasText: 'All repos' }).click();
  await page.keyboard.press('Escape');
  await page.locator('.modal.settings').waitFor({ state: 'detached', timeout: 5000 });
  await headIs(
    page,
    [
      { name: 'home', files: ['a.txt'] },
      { name: 'ref', files: ['b.txt'] },
    ],
    'Settings → All repos shows both heads',
  );
  await waitFor(
    page,
    (id) => (window.__sessions || []).find((x) => x.id === id)?.repoPinned === false,
    sid,
    'Settings → Changes view → All repos unpins (D15)',
  );
  log('AC3: Settings → All repos → two heads, repoPinned false ✓');

  const refBeforeConfirm = porcelain(ref);
  await refHead.locator('.repo-head__name').click({ button: 'right' });
  await page
    .locator('.ctxmenu [role="menuitem"]', { hasText: 'Discard all changes' })
    .click({ timeout: 5000 });
  await page.waitForSelector('.confirm', { state: 'visible', timeout: 5000 });
  const confirmMsg = await page.textContent('.confirm .confirm__msg');
  await page.locator('.confirm .confirm__actions button', { hasText: 'Cancel' }).click();
  await page.waitForSelector('.confirm', { state: 'detached', timeout: 5000 });
  assert(
    confirmMsg ===
      'Discard all 1 change in ref? Untracked files are deleted too. This cannot be undone.',
    `S-5: the per-repo Discard all confirm names the repo and the untracked delete: ${JSON.stringify(confirmMsg)}`,
  );
  assert(porcelain(ref) === refBeforeConfirm, 'Cancel leaves ref untouched');
  log(
    'Discard all on the ref head: confirm names ref and the untracked delete; Cancel is a no-op ✓',
  );

  const refRow = await changeRow(page, 'Changes', 'b.txt', { repo: 'ref' });
  await refRow.click();
  const want = fwd(join(ref, 'b.txt')).toLowerCase();
  await waitFor(
    page,
    (w) =>
      Array.from(document.querySelectorAll('.tabbar [data-tabid]'), (t) =>
        (t.getAttribute('data-tabid') ?? '').replace(/\\/g, '/').toLowerCase(),
      ).some((id) => /^diff(@[a-z]+)?:/.test(id) && id.slice(id.indexOf(':') + 1) === w),
    want,
    `a diff tab for ${want}`,
  ).catch(async (e) => {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.tabbar [data-tabid]'), (t) =>
        t.getAttribute('data-tabid'),
      ),
    );
    log('tab ids', JSON.stringify(ids));
    throw e;
  });
  log('AC4: ref row opens the diff tab for ref/b.txt ✓');

  const refBefore = porcelain(ref);
  const aRow = await changeRow(page, 'Changes', 'a.txt', { repo: 'home' });
  await aRow.hover();
  await aRow.getByRole('button', { name: 'Discard' }).click();
  await page.locator('.confirm .confirm__actions button', { hasText: 'Discard' }).click();
  await headIs(
    page,
    [
      { name: 'home', files: [] },
      { name: 'ref', files: ['b.txt'] },
    ],
    'home is clean after the discard',
  );
  assert(
    porcelain(home) === '',
    `home clean on disk after discard: ${JSON.stringify(porcelain(home))}`,
  );
  assert(
    porcelain(ref) === refBefore,
    `ref untouched by home's discard: ${JSON.stringify(porcelain(ref))}`,
  );
  log('AC4: discard a.txt → home clean on disk, ref byte-identical ✓');

  await openHistory(page, { repo: 'ref' });
  await waitFor(
    page,
    () => {
      const subs = Array.from(
        document.querySelectorAll('.gh__row .gh__subject'),
        (n) => n.textContent,
      );
      return (
        document.querySelector('.gh__head .gh__repo')?.textContent?.trim() === 'ref' &&
        subs.includes('ref-subject') &&
        !subs.includes('home-subject') &&
        !subs.includes('home-a')
      );
    },
    null,
    "History header reads ref and lists only ref's commits",
  );
  log("History: header chip ref, ref-subject present, home's subjects absent ✓");

  await openChangesTab(page);
  const refChip = refHead.locator('.branch-chip');
  await refChip.click();
  await page
    .locator('.branch-chip-menu .git-branch-menu__row', { hasText: 'feature' })
    .click({ timeout: 10000 });
  await waitFor(
    page,
    () => {
      const h = Array.from(document.querySelectorAll('.repo-head')).find(
        (x) => x.querySelector('.repo-head__name')?.textContent === 'ref',
      );
      return h?.querySelector('.branch-chip .branch-chip__label')?.textContent === 'feature';
    },
    null,
    'the ref chip reads feature without a focus change',
  );
  assert(head(ref) === 'feature', `ref HEAD is feature: ${head(ref)}`);
  assert(head(home) === 'main', `home HEAD stays main: ${head(home)}`);
  const chips = (await readHeads(page)).map((h) => [h.name, h.chip]);
  assert(
    JSON.stringify(chips) ===
      JSON.stringify([
        ['home', 'main'],
        ['ref', 'feature'],
      ]),
    `only ref's chip changed: ${JSON.stringify(chips)}`,
  );
  log('switch: ref HEAD feature, home HEAD main, ref chip reads feature ✓');

  const reviewCounts = await page.evaluate(() => ({
    sections: document.querySelectorAll('.changes__section').length,
    sectionControls: document.querySelectorAll(
      '.changes__section button, .changes__section [role="button"]',
    ).length,
    review: document.querySelectorAll('.changes__review').length,
  }));
  assert(
    reviewCounts.sections > 0 && reviewCounts.sectionControls === 0 && reviewCounts.review === 1,
    `AC8: section heads render with no control on them, 1 .changes__review: ${JSON.stringify(reviewCounts)}`,
  );
  assert(
    (await assertAriaControlsResolve(page, 'dirty ref')) === 2,
    'both chevrons carry aria-controls while each list renders',
  );
  git(ref, 'add', 'b.txt');
  git(ref, 'commit', '-qm', 'ref-b');
  await page.click('.changes__refresh');

  await expectEmpty(page, 'No changes', 'All 2 repos are clean.', 'two clean repos');
  await assertAriaControlsResolve(page, 'all clean');
  assert(
    (await page.textContent('.changes__header-count')) === 'No changes',
    'clean header reads No changes',
  );
  await page.click('.changes__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 15000 });
  assert(
    /Nothing to review/i.test((await page.textContent('.review')) ?? ''),
    "AC8: Review on a clean tree shows Review's empty state",
  );
  log('AC8: one Review button, no section icons; clean tree → Review empty state ✓');
  await page.click('.tab[data-tabid="__terminal__"]');
  await page.waitForSelector('.review', { state: 'hidden', timeout: 10000 });
  await openChangesTab(page);

  await page.evaluate(
    ({ id, p }) =>
      window.agentDeck.post({ type: 'session:addRoot', sessionId: id, path: p, requestId: 7101 }),
    { id: sid, p: fwd(third) },
  );
  await waitFor(
    page,
    (id) => (window.__sessions || []).find((x) => x.id === id)?.repos?.length === 3,
    sid,
    'session:addRoot adds a third repo',
    20000,
  );
  await expectEmpty(page, 'No changes', 'All 3 repos are clean.', 'three clean repos');
  log('AC9: "All 2 repos are clean." then, after session:addRoot, "All 3 repos are clean." ✓');

  // AC3's restart half: leave the view on Active for the relaunch.
  await setView(page, 'Active repo');
  await waitFor(
    page,
    () => document.querySelectorAll('.repo-head').length === 1,
    null,
    'Active view before the relaunch',
  );
  return sid;
}

async function runSecondLaunch(page, sid) {
  await tapBridge(page);
  await waitFor(
    page,
    (id) => (window.__sessions || []).some((x) => x.id === id),
    sid,
    'the session is restored',
    30000,
  );
  const restored = await sessionOf(page, sid);
  if (restored?.status !== 'running') {
    await page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), sid);
  }
  await page.locator(`[data-sessionid="${sid}"] .session__text`).click();
  await openChangesTab(page);
  await waitFor(
    page,
    () =>
      document.querySelectorAll('.repo-head').length === 1 &&
      !!document.querySelector('.repo-head .repo-head__picker'),
    null,
    'relaunch keeps the Active view: one head with a picker',
    30000,
  ).catch(async (e) => {
    const s = await sessionOf(page, sid);
    const right = await page.evaluate(
      () => document.querySelector('.rightpane')?.innerText ?? null,
    );
    log('after relaunch', JSON.stringify({ status: s?.status, repos: s?.repos, right }));
    throw e;
  });
  log('AC3: after a relaunch on the same userData the Active view (one head) survives ✓');

  await setView(page, 'All repos');
  const plainSid = await openSession(page, { path: plain });
  await expectEmpty(
    page,
    'No git repos',
    "None of this session's folders is a git repository.",
    'a non-git session',
  );
  const soloSid = await openSession(page, { path: solo });
  await expectEmpty(page, 'No changes', 'The working tree is clean.', 'a single clean repo');
  log('AC9: "No git repos" for a non-git session, "The working tree is clean." for one repo ✓');

  // The harness passes the app dir as argv, which opens a session of its own on every launch.
  const all = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));
  assert(
    [sid, plainSid, soloSid].every((id) => all.includes(id)),
    `the three sessions are listed: ${JSON.stringify(all)}`,
  );
  for (const id of all) {
    await page.evaluate((x) => window.agentDeck.post({ type: 'kill', id: x }), id);
  }
  await waitFor(
    page,
    () => (window.__sessions || []).length === 0,
    null,
    'every session killed',
    20000,
  );
  await expectEmpty(page, 'No session', 'Start a session to see its changes here.', 'no session');
  log('AC9: every session killed → "No session" ✓');
}

let code = 0;
let launched = null;
try {
  launched = await launchApp({ userDataDir });
  const sid = await runFirstLaunch(launched.page);
  await closeApp(launched.app, launched.page);
  await shutdownApp(launched.app, null);
  launched = await launchApp({ userDataDir });
  await runSecondLaunch(launched.page, sid);
  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error(`[${NAME}] ERROR:`, e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
process.exit(code);
