/**
 * Repo head geometry with a long repo name (engine review r3, r4, r5). The head's first line
 * (chevron, glyph, name, tag, branch chip) never wraps and sits above the sub-path; the chip gives
 * up its text before the name ellipsizes, the tag word first; the chip floors at its glyphs, dirty
 * dot and caret, nothing else, with no sliver of squeezed text painting over them; and a tag pill
 * shows only beside an 80px name. Three long-name linked worktrees, so each chip carries the
 * worktree and the branch glyph: one on a branch, one detached in a conflicting rebase (REBASING
 * op badge, "detached" tag, SHA), and one attached whose chip keeps its worktree segment. Rendered
 * layout in the real app; a style-only check would not count.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assert, openChangesTab, openSession, runScenario } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LONG = 'a-really-long-repository-name-abc-36';
const REBASING = 'a-long-worktree-mid-rebase-name-xyz';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/**
 * A repo on `main` with two dirty linked worktrees beside it: `long` on `branch`, and `rebasing`
 * stopped on a conflict while rebasing onto `main`, which leaves it detached. A third dirty linked
 * worktree, also named `long`, lives in `elsewhere`: attached, so its head carries the widest pill
 * ("Attached"), and its label gains the parent folder, so its chip keeps the worktree segment.
 */
function makeRepoWithWorktrees(root, { long, branch, rebasing, elsewhere }) {
  const main = join(root, 'ref');
  mkdirSync(main, { recursive: true });
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 't@t']);
  git(main, ['config', 'user.name', 't']);
  git(main, ['config', 'core.autocrlf', 'false']);
  git(main, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(main, 'a.txt'), 'one\n');
  git(main, ['add', '.']);
  git(main, ['commit', '-qm', 'init']);

  const rb = join(root, rebasing);
  git(main, ['worktree', 'add', '-q', '-b', 'topic', rb]);
  writeFileSync(join(rb, 'a.txt'), 'topic\n');
  git(rb, ['commit', '-qam', 'topic']);
  writeFileSync(join(main, 'a.txt'), 'main\n');
  git(main, ['commit', '-qam', 'main']);
  let conflicted = false;
  try {
    git(rb, ['rebase', 'main']);
  } catch {
    conflicted = true;
  }
  assert(conflicted, 'the rebase stops on a conflict');

  writeFileSync(join(main, 'a.txt'), 'two\n');
  git(main, ['worktree', 'add', '-q', '-b', branch, join(root, long)]);
  writeFileSync(join(root, long, 'a.txt'), 'three\n');

  git(main, ['worktree', 'add', '-q', '-b', `${branch}-2`, join(elsewhere, long)]);
  writeFileSync(join(elsewhere, long, 'a.txt'), 'four\n');
}

const headWidth = (page, name) =>
  page.evaluate((n) => {
    const head = [...document.querySelectorAll('.repo-head')].find(
      (h) => h.querySelector('.repo-head__name')?.textContent === n,
    );
    return head.getBoundingClientRect().width;
  }, name);

/** Resize the right pane until the `name` head is `target` px wide; returns the width reached. */
async function setHeadWidth(page, name, target) {
  for (let i = 0; i < 4; i++) {
    const head = await headWidth(page, name);
    if (Math.abs(head - target) <= 0.5) break;
    const pane = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--right-w')),
    );
    await page.evaluate(
      (w) => document.documentElement.style.setProperty('--right-w', `${w}px`),
      pane - (head - target),
    );
    await sleep(150);
  }
  return headWidth(page, name);
}

const measure = (page, headName) =>
  page.evaluate((n) => {
    const head = [...document.querySelectorAll('.repo-head')].find(
      (h) => h.querySelector('.repo-head__name')?.textContent === n,
    );
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const name = head.querySelector('.repo-head__name');
    const chip = head.querySelector('.branch-chip');
    const fit = (chip.querySelector('.branch-chip__fit') ?? chip).getBoundingClientRect();
    // Width of a piece of chip text that is actually painted: its box clipped to the one-line
    // box (a wrapped-away tag sits below it) and to its own zero-min track.
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, fit.right) - Math.max(r.left, fit.left);
      const h = Math.min(r.bottom, fit.bottom) - Math.max(r.top, fit.top);
      return w > 0 && h > 0 ? w : 0;
    };
    const text = (sel) =>
      [...chip.querySelectorAll(sel)].map((el) => {
        const inner = el.querySelector('.branch-chip__text') ?? el;
        return { sel, w: shown(el), cut: inner.scrollWidth > inner.clientWidth };
      });
    // Each text clips its content at its own padding box; what of that box survives every
    // clipping ancestor up to the chip is what paints. Its padding can overflow a 0 track.
    const painted = (el) => {
      const r = el.getBoundingClientRect();
      let left = r.left;
      let right = r.right;
      for (let a = el.parentElement; a && chip.contains(a); a = a.parentElement) {
        if (getComputedStyle(a).overflowX === 'visible') continue;
        const ar = a.getBoundingClientRect();
        left = Math.max(left, ar.left + a.clientLeft);
        right = Math.min(right, ar.left + a.clientLeft + a.clientWidth);
      }
      return Math.max(0, right - left);
    };
    const textBoxes = [...chip.querySelectorAll('.branch-chip__text')].map((el) => ({
      cls: el.parentElement.className,
      text: box(el),
      shrink: box(el.parentElement),
      painted: painted(el),
    }));
    const floorParts = [
      ...chip.querySelectorAll('.branch-chip__glyph, .branch-chip__dirty, .branch-chip__caret'),
    ];
    const cs = getComputedStyle(chip);
    const px = (v) => parseFloat(v) || 0;
    const gap = px(cs.columnGap);
    const mainGap = px(
      getComputedStyle(chip.querySelector('.branch-chip__main') ?? chip).columnGap,
    );
    const worktreeGlyphs = chip.querySelectorAll(
      '.branch-chip__worktree .branch-chip__glyph',
    ).length;
    // Glyphs + dot + caret, the chip's own padding and border, and the gaps between those
    // pieces only: the worktree group and the branch group share the main gap, and the main
    // group, dot and caret share the chip gap.
    const floor =
      floorParts.reduce(
        (a, el) => a + el.getBoundingClientRect().width + px(getComputedStyle(el).marginLeft),
        0,
      ) +
      px(cs.paddingLeft) +
      px(cs.paddingRight) +
      px(cs.borderLeftWidth) +
      px(cs.borderRightWidth) +
      (worktreeGlyphs ? mainGap : 0) +
      gap * (chip.querySelector('.branch-chip__dirty') ? 2 : 1);
    const scroller = head.closest('.rightpane__scroll');
    return {
      head: box(head),
      chev: box(head.querySelector('.repo-head__chev')),
      name: box(name),
      nameEllipsized: name.scrollWidth > name.clientWidth,
      // null once the narrow-head container query has hidden it
      tag: head.querySelector('.repo-head__tag')?.getClientRects().length
        ? box(head.querySelector('.repo-head__tag'))
        : null,
      chip: box(chip),
      glyphs: [...chip.querySelectorAll('.branch-chip__glyph')].map((g) => ({
        ...box(g),
        parent: box(g.parentElement),
      })),
      texts: [
        ...text('.branch-chip__label'),
        ...text('.branch-chip__op'),
        ...text('.branch-chip__sep'),
        ...text('.branch-chip__tag'),
      ],
      textBoxes,
      op: chip.querySelector('.branch-chip__op')?.textContent ?? null,
      chipTag: chip.querySelector('.branch-chip__tag')?.textContent ?? null,
      floor,
      overflowX: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
      sub: box(head.querySelector('.repo-head__sub')),
    };
  }, headName);

/** The r3 + r4 geometry contract for one head at one width; returns whether the name was cut. */
async function checkHead(page, log, headName, target) {
  const reached = await setHeadWidth(page, headName, target);
  assert(
    Math.abs(reached - target) <= 2,
    `${headName}: head reached ${reached}px, wanted ${target}px (±2)`,
  );
  const m = await measure(page, headName);
  const at = `${headName}@${Math.round(m.head.width)}px`;
  const line = [m.chev, m.name, m.chip, ...(m.tag ? [m.tag] : [])];
  assert(
    line.every(Boolean) && m.sub,
    `${at} chevron, name, chip and sub-path all render: ${JSON.stringify(m)}`,
  );

  // 1. One line: every first-row item shares a vertical band, all above the sub-path.
  const bandTop = Math.max(...line.map((b) => b.top));
  const bandBottom = Math.min(...line.map((b) => b.bottom));
  assert(
    bandTop < bandBottom,
    `${at} chevron, name, tag and chip sit on one line: ${JSON.stringify(line)}`,
  );
  assert(
    m.sub.top >= Math.max(...line.map((b) => b.bottom)) - 0.5,
    `${at} the sub-path sits below the first line: sub ${JSON.stringify(m.sub)}`,
  );

  // 2. The name ellipsizes only once the chip shows no text at all: labels, op badge, tag word.
  const textRoom = m.texts.reduce((a, t) => a + t.w, 0);
  assert(
    !m.nameEllipsized || textRoom <= 0.5,
    `${at} name ellipsized while the chip still shows text ${JSON.stringify(m.texts)}`,
  );

  // 2b. The repo name wins over the head's tag pill: a shown pill never leaves the name cut short.
  assert(
    !m.tag || !m.nameEllipsized || m.name.width >= 79.5,
    `${at} the tag pill shows while the name is cut to ${m.name.width}px`,
  );

  // 3. The tag word goes first: while it shows, no label or op badge is cut.
  const tagShown = m.texts.some((t) => t.sel === '.branch-chip__tag' && t.w > 0);
  assert(
    !tagShown || m.texts.every((t) => !t.cut),
    `${at} the tag word shows while chip text is cut: ${JSON.stringify(m.texts)}`,
  );

  // 4. The chip is never narrower than its glyphs, and no glyph is folded out of its own box.
  assert(
    m.glyphs.length === 2 &&
      m.glyphs.every((g) => g.width > 0 && g.left >= m.chip.left && g.right <= m.chip.right + 0.5),
    `${at} chip ${JSON.stringify(m.chip)} holds its glyphs ${JSON.stringify(m.glyphs)}`,
  );
  assert(
    m.glyphs.every((g) => g.left >= g.parent.left - 0.5 && g.right <= g.parent.right + 0.5) &&
      m.glyphs[0].right <= m.glyphs[1].left,
    `${at} each glyph keeps its own room: ${JSON.stringify(m.glyphs)}`,
  );

  // 5. Nothing escapes the head: the chip stays inside it and the list never scrolls sideways.
  assert(
    m.chip.left >= m.head.left - 0.5 && m.chip.right <= m.head.right + 0.5,
    `${at} chip stays inside the head: ${JSON.stringify(m.chip)} vs ${JSON.stringify(m.head)}`,
  );
  assert(
    m.overflowX !== null && m.overflowX <= 0,
    `${at} the Changes list has no horizontal overflow: ${m.overflowX}px`,
  );

  // 6. A cut name means the chip is at its floor: glyphs, dot and caret, nothing else.
  if (m.nameEllipsized) {
    assert(
      Math.abs(m.chip.width - m.floor) <= 1,
      `${at} chip floors at ${m.floor}px (glyphs + dot + caret), got ${m.chip.width}px`,
    );
    // 7. At the floor no squeezed text paints a sliver over a glyph (engine review r5): each text
    // box stays inside its shrink track, or nothing of it paints.
    const stray = m.textBoxes.filter(
      (t) =>
        !(t.text.left >= t.shrink.left - 0.5 && t.text.right <= t.shrink.right + 0.5) &&
        t.painted > 0.5,
    );
    assert(
      stray.length === 0,
      `${at} squeezed chip text paints outside its track: ${JSON.stringify(stray)}`,
    );
  } else {
    assert(textRoom > 0, `${at} a whole name leaves the chip room for its text`);
  }
  log(
    `${at} one line; name ${m.nameEllipsized ? 'ellipsized' : 'whole'}, chip ${Math.round(
      m.chip.width,
    )}px (floor ${Math.round(m.floor)}px, text ${Math.round(textRoom)}px${
      m.texts.some((t) => t.cut) ? ', some cut' : ''
    }${tagShown ? ', tag shown' : ''}) ✓`,
  );
  return m;
}

runScenario('repo-head-fit', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-headfit-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'conduit-headfit-att-'));
  makeRepoWithWorktrees(root, {
    long: LONG,
    branch: 'feature/a-fairly-long-branch-name',
    rebasing: REBASING,
    elsewhere,
  });
  // repoLabel: an attached repo whose name collides gains its parent folder.
  const ATTACHED = `${LONG} — ${basename(elsewhere)}`;

  const sid = await openSession(page, {
    path: root.replace(/\\/g, '/'),
    roots: [elsewhere],
  });
  await page.waitForFunction(
    (id) => ((window.__sessions || []).find((x) => x.id === id)?.repos?.length ?? 0) >= 4,
    sid,
    { timeout: 20000 },
  );
  await openChangesTab(page);
  await page.waitForFunction(
    ([long, rebasing, attached]) => {
      const head = (n) =>
        [...document.querySelectorAll('.repo-head')].find(
          (h) => h.querySelector('.repo-head__name')?.textContent === n,
        );
      const ready = (h) =>
        h?.querySelector('.repo-head__sub') &&
        h.querySelector('.branch-chip:not(:disabled) .branch-chip__worktree');
      return (
        ready(head(long)) &&
        ready(head(rebasing)) &&
        head(rebasing).querySelector('.branch-chip__op') &&
        ready(head(attached)) &&
        head(attached).querySelector('.branch-chip__sep')
      );
    },
    [LONG, REBASING, ATTACHED],
    { timeout: 20000 },
  );

  // Narrow, the default pane, and wide enough that the name fits whole with room to spare.
  const seen = { whole: false, ellipsized: false };
  for (const width of [220, 330, 480]) {
    const m = await checkHead(page, log, LONG, width);
    seen[m.nameEllipsized ? 'ellipsized' : 'whole'] = true;
  }
  assert(
    seen.whole && seen.ellipsized,
    `both a whole and an ellipsized name were measured: ${JSON.stringify(seen)}`,
  );

  // The ruled narrow and default widths, then wider steps that walk the give-way order: tag word
  // gone with the op badge and SHA cut, then everything whole.
  for (const width of [220, 330, 400, 460, 560]) {
    const m = await checkHead(page, log, REBASING, width);
    assert(
      m.op === 'REBASING' && m.chipTag === 'detached',
      `${REBASING}: the chip shows REBASING and the detached tag: ${m.op} / ${m.chipTag}`,
    );
  }

  // The widest pill and the worktree segment: the floor, the band where a threshold taken from
  // the narrower "Nested" pill showed "Attached" over a name cut below 80px, and the default pane.
  let attachedPill = false;
  for (const width of [220, 262, 264, 266, 268, 272, 330]) {
    const m = await checkHead(page, log, ATTACHED, width);
    assert(
      m.textBoxes.some((t) => t.cls.includes('branch-chip__sep')),
      `${ATTACHED}: the chip keeps its worktree segment: ${JSON.stringify(m.textBoxes)}`,
    );
    if (m.tag) attachedPill = true;
  }
  assert(attachedPill, `${ATTACHED}: the Attached pill shows at some measured width`);
});
