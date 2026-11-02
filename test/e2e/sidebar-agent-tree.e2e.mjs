/**
 * sidebar-agent-tree — the agent forest from real server facts (spec
 * docs/specs/2026-11-02-sidebar-agent-tree.md §4–§5; plan "New exact scenario files").
 * Every session runs the fake MCP agent; children are opened through the real MCP `open_session`,
 * so the host stamps `openedBy`. Status comes from the server: a qualifying `busy` run is a
 * heuristic completion, a BEL echoed while hidden is the `bell` Needs-you reason.
 *   - parent P → child C → grandchild G: aria-level 2 / 3 / 4, DOM order follows the tree;
 *   - child Done discount: C's counted completion shows Idle nested and never makes P Done;
 *   - a Needs-you grandchild lifts every ancestor into Needs you (root count only), adds
 *     ", a sub-agent needs you" to each ancestor's label and leaves its own status word;
 *   - folds: row fold hides descendants but not the promotion; group fold; ArrowDown / ArrowUp /
 *     ArrowLeft / ArrowRight skip folded rows;
 *   - closing P leaves C running as a root that now shows its own Done;
 *   - a parent owned by another window makes the child a root here.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fakeAgentProfile,
  keys,
  openFake,
  sessions,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario, tapBridge, typeLine } from './harness.mjs';
import {
  focused,
  groupHeader,
  groupOf,
  killAll,
  nameOf,
  openChild,
  pressAndExpectFocus,
  row,
  sessionOf,
  treeItems,
  waitFact,
  waitGroup,
  waitLabel,
  waitRows,
} from './sidebar-tree-helpers.mjs';

const BEL = '\x07';

await runScenario(
  'sidebar-agent-tree',
  async ({ app, page, log }) => {
    await tapMcp(page);
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-agent-tree-${label}-`));
    const dirs = { p: temp('p'), x: temp('x'), c: temp('c'), g: temp('g') };

    phase('setup');
    // The launch's folder-arg session would be one more root in every assertion below.
    await killAll(page);
    const p = (await openFake(page, dirs.p)).sessionId;
    // X is the active root, so the tree has a later item to move focus to and P's subtree is
    // off screen: Needs you must not fire for a session the server already shows (spec §4).
    const x = (await openFake(page, dirs.x)).sessionId;
    const c = await openChild(page, p, { path: dirs.c, label: 'tree-child' });
    const g = await openChild(page, c, { path: dirs.g, label: 'tree-grandchild' });
    const pName = await nameOf(page, p);
    log({ p, x, c, g });

    phase('nesting');
    await waitRows(page, [p, x, c, g], 'all four agents');
    const items = await treeItems(page);
    const at = (id) => items.findIndex((i) => i.kind === 'row' && i.id === id);
    const lv = (id) => items[at(id)].level;
    assert(
      lv(p) === 2 && lv(c) === 3 && lv(g) === 4 && lv(x) === 2,
      `aria-level P/C/G/X should be 2/3/4/2: ${JSON.stringify(items)}`,
    );
    assert(
      at(c) === at(p) + 1 && at(g) === at(c) + 1,
      `C directly follows P and G directly follows C: ${JSON.stringify(items)}`,
    );
    assert(
      items[at(p)].expanded === 'true' &&
        items[at(c)].expanded === 'true' &&
        items[at(g)].expanded === null,
      `aria-expanded only where there are children: ${JSON.stringify(items)}`,
    );
    for (const i of items.filter((i) => i.kind === 'group'))
      assert(i.level === 1, `a group header is level 1: ${JSON.stringify(i)}`);
    log('openedBy nesting P → C → G at levels 2/3/4, in tree order ✓');

    phase('child Done discount');
    await waitLabel(page, p, `${pName}, Idle`, 'P settles Idle before the child runs');
    await waitLabel(page, c, 'tree-child, Idle', 'C settles Idle before its run');
    const before = (await sessionOf(page, c)).completions ?? 0;
    const pBefore = (await sessionOf(page, p)).completions ?? 0;
    // Over MIN_RUN_MS of output, then quiet: one heuristic completion (spec §4).
    await typeLine(page, c, 'busy 3000');
    await waitFact(
      () => sessionOf(page, c),
      (s) => (s?.completions ?? 0) > before && s.busy === false,
      'the server should count C’s run as a completion',
      30_000,
    );
    await waitLabel(page, c, 'tree-child, Idle', 'a nested Done reads Idle');
    assert(
      (await row(page, c).locator('.session__mark .agentmark__dot--idle').count()) === 1,
      'C’s nested mark is the Idle ring',
    );
    assert(
      ((await sessionOf(page, p)).completions ?? 0) === pBefore,
      'precondition: P itself completed nothing meanwhile',
    );
    await waitLabel(page, p, `${pName}, Idle`, 'P keeps its own status');
    const pGroup = await groupOf(page, p);
    assert(pGroup === 'idle', `a child's Done never lifts P into Done, P is under ${pGroup}`);
    log('child completion counted, shown Idle nested, P stays Idle ✓');

    phase('blocked descendant promotion');
    // A bare BEL echoed by a hidden, non-reporting program is the `bell` reason.
    await keys(page, g, BEL);
    await waitFact(
      () => sessionOf(page, g),
      (s) => s?.attentionReason === 'bell',
      'the server should raise G’s bell reason',
    );
    await waitLabel(page, g, 'tree-grandchild, Needs you', 'G needs you');
    await waitLabel(
      page,
      c,
      'tree-child, Idle, a sub-agent needs you',
      'C keeps its own word and says a sub-agent needs you',
    );
    await waitLabel(
      page,
      p,
      `${pName}, Idle, a sub-agent needs you`,
      'P keeps its own word and says a sub-agent needs you',
    );
    await waitGroup(page, p, 'blocked', 'a Needs-you grandchild lifts the root');
    assert(
      (await groupHeader(page, 'blocked').getAttribute('aria-label')) === 'Needs you (1)',
      `the Needs you header counts roots only: ${await groupHeader(page, 'blocked').getAttribute('aria-label')}`,
    );
    assert(
      (await row(page, c).getAttribute('class')).includes('session--attention'),
      'the unselected ancestor C carries the attention chrome',
    );
    assert(
      (await row(page, p).locator('.session__mark .agentmark__dot--idle').count()) === 1,
      'P’s own mark still shows Idle',
    );
    assert((await groupOf(page, x)) !== 'blocked', 'the unrelated root X is not promoted');
    log('G Needs you → C and P promoted, own words kept, header counts 1 root ✓');

    phase('row fold');
    const pFold = row(page, p).locator('[data-agent-action="fold"]');
    assert((await pFold.getAttribute('aria-expanded')) === 'true', 'P’s fold starts expanded');
    assert(
      (await pFold.getAttribute('aria-label')) === 'Hide sub-agents',
      `P's fold label: ${await pFold.getAttribute('aria-label')}`,
    );
    await pFold.click();
    await waitRows(page, [p, x], 'folding P hides C and G');
    assert((await pFold.getAttribute('aria-expanded')) === 'false', 'P’s fold reads collapsed');
    assert((await row(page, p).getAttribute('aria-expanded')) === 'false', 'P row collapsed');
    assert(
      (await pFold.getAttribute('aria-label')) === 'Show sub-agents',
      'a folded row offers Show sub-agents',
    );
    const kids = (await row(page, p).locator('.session__kids').textContent())?.trim();
    assert(kids === '2', `the folded count includes every descendant, got ${kids}`);
    await waitGroup(page, p, 'blocked', 'a folded Needs-you descendant still lifts P');
    log('fold hides C+G, shows 2, P stays in Needs you ✓');

    phase('keyboard skips folded rows');
    const after = (list, id) => {
      const i = list.findIndex((t) => t.kind === 'row' && t.id === id);
      const next = list[i + 1];
      return next ? (next.kind === 'group' ? `group:${next.key}` : next.id) : null;
    };
    const nextAfterP = after(await treeItems(page), p);
    assert(
      nextAfterP !== null && nextAfterP !== c && nextAfterP !== g,
      `precondition: something other than P’s hidden subtree follows P (${nextAfterP})`,
    );
    await row(page, p).focus();
    assert((await focused(page)) === p, 'P row takes focus');
    await pressAndExpectFocus(page, 'ArrowDown', nextAfterP, 'ArrowDown from folded P');
    await pressAndExpectFocus(page, 'ArrowUp', p, 'ArrowUp back to P');
    await page.keyboard.press('ArrowRight');
    await waitRows(page, [p, x, c, g], 'ArrowRight on folded P unfolds it');
    assert((await focused(page)) === p, 'unfolding keeps focus on P');
    await pressAndExpectFocus(page, 'ArrowRight', c, 'ArrowRight on open P');
    await pressAndExpectFocus(page, 'ArrowDown', g, 'ArrowDown from C');
    await pressAndExpectFocus(page, 'ArrowLeft', c, 'ArrowLeft from leaf G');
    await page.keyboard.press('ArrowLeft');
    await waitRows(page, [p, x, c], 'ArrowLeft on open C folds it');
    assert((await focused(page)) === c, 'folding keeps focus on C');
    const nextAfterC = after(await treeItems(page), c);
    assert(nextAfterC !== g, 'G is gone from the order');
    await pressAndExpectFocus(page, 'ArrowDown', nextAfterC, 'ArrowDown from folded C skips G');
    await pressAndExpectFocus(page, 'ArrowUp', c, 'ArrowUp back to C');
    await pressAndExpectFocus(page, 'ArrowUp', p, 'ArrowUp to P');
    await pressAndExpectFocus(page, 'ArrowLeft', p, 'ArrowLeft on open P folds, focus stays');
    await waitRows(page, [p, x], 'ArrowLeft on open P folds it');
    await pressAndExpectFocus(page, 'ArrowLeft', 'group:blocked', 'ArrowLeft on folded root');
    // Restore both subtrees through their fold buttons for what follows.
    await pFold.click();
    await row(page, c).locator('[data-agent-action="fold"]').click();
    await waitRows(page, [p, x, c, g], 'P and C unfolded again');
    log('Arrow keys follow the visible order, folding and unfolding in place ✓');

    phase('group fold');
    const blocked = groupHeader(page, 'blocked');
    await blocked.click();
    await waitRows(page, [x], 'folding Needs you hides its whole subtree');
    assert((await blocked.getAttribute('aria-expanded')) === 'false', 'header reads collapsed');
    const nextAfterHeader = await page.evaluate(() => {
      const h = document.querySelector('[data-agent-tree] [data-agent-group="blocked"]');
      const n = h?.nextElementSibling;
      if (!n) return null;
      return n.hasAttribute('data-agent-group')
        ? `group:${n.getAttribute('data-agent-group')}`
        : n.getAttribute('data-sessionid');
    });
    assert(nextAfterHeader !== null, 'something follows the folded header');
    await blocked.focus();
    await pressAndExpectFocus(page, 'ArrowDown', nextAfterHeader, 'ArrowDown from a folded group');
    await pressAndExpectFocus(page, 'ArrowUp', 'group:blocked', 'ArrowUp back to the header');
    await page.keyboard.press('ArrowRight');
    await waitRows(page, [p, x, c, g], 'ArrowRight on a folded header unfolds it');
    assert((await blocked.getAttribute('aria-expanded')) === 'true', 'header reads expanded');
    log('group fold hides its rows and the keyboard skips them ✓');

    phase('parent close leaves the child a root');
    await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), p);
    await waitRows(page, [x, c, g], 'P is gone, C and G stay');
    const cAfter = await sessionOf(page, c);
    assert(cAfter?.status === 'running', `C keeps running: ${cAfter?.status}`);
    const rooted = await treeItems(page);
    const lvl = (id) => rooted.find((i) => i.kind === 'row' && i.id === id)?.level;
    assert(lvl(c) === 2 && lvl(g) === 3, `C becomes a root over G: ${JSON.stringify(rooted)}`);
    // Detached, C is a root: its own counted completion is Done again, still unseen.
    await waitLabel(page, c, 'tree-child, Done, a sub-agent needs you', 'root C shows its Done');
    await waitGroup(page, c, 'blocked', 'G still lifts its new root');
    // Looking at G puts its bell down (server visibility), so C ranks on its own Done.
    await row(page, g).locator('[data-agent-action="select"]').click();
    await waitFact(
      () => sessionOf(page, g),
      (s) => s?.attentionReason == null,
      'viewing G should clear its bell reason',
    );
    await waitLabel(page, c, 'tree-child, Done', 'C, Done once nothing below needs you');
    await waitGroup(page, c, 'done', 'C sorts into Done as a root');
    log('closing P: C runs on as a root, Done, over G ✓');

    phase('parent in another window');
    const nextWin = app.waitForEvent('window', { timeout: 20_000 });
    await page.evaluate(
      (id) =>
        window.agentDeck.post({ type: 'session:move', sessionId: id, target: { kind: 'new' } }),
      c,
    );
    const page2 = await nextWin;
    await page2.waitForLoadState('domcontentloaded');
    await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20_000 });
    await tapBridge(page2);
    await waitRows(page, [x, g], 'window 1 no longer owns C', 20_000);
    const here = await treeItems(page);
    assert(
      here.find((i) => i.kind === 'row' && i.id === g)?.level === 2,
      `G, whose parent lives in another window, is a root here: ${JSON.stringify(here)}`,
    );
    assert(
      (await sessionOf(page, g))?.openedBy?.sessionId === c,
      'G’s openedBy still names C; only the window boundary made it a root',
    );
    await waitRows(page2, [c], 'window 2 shows only C', 20_000);
    const there = await treeItems(page2);
    const cThere = there.find((i) => i.kind === 'row' && i.id === c);
    assert(
      cThere?.level === 2 && cThere.expanded === null,
      `C in window 2 has no children there: ${JSON.stringify(there)}`,
    );
    assert(
      (await row(page2, c).locator('[data-agent-action="fold"]').count()) === 0,
      'a row whose children live elsewhere has no fold control',
    );
    log('a foreign-window parent leaves its child a root ✓');

    phase('cleanup');
    for (const pg of [page2, page]) {
      for (const s of await sessions(pg))
        await pg.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(
        async () => (await sessions(page)).length === 0 && (await sessions(page2)).length === 0,
        15_000,
      ),
      'sessions survived kill',
    );
    for (const d of Object.values(dirs)) await removeDir(d, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('agent-tree') },
);
