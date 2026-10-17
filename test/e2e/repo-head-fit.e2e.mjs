/**
 * Repo head geometry with a long repo name (engine review r3). The head's first line (chevron,
 * glyph, name, tag, branch chip) never wraps and sits above the sub-path; the chip gives up its
 * labels before the name ellipsizes; and the chip never shrinks past its glyphs. The long head is a
 * linked worktree, so its chip carries both the worktree and the branch glyph. Rendered layout in
 * the real app at a narrow, the default and a wide pane width; a style-only check would not count.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openChangesTab, openSession, runScenario } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LONG = 'a-really-long-repository-name-abc-36';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** A repo on `main` with a linked worktree beside it on `branch`, both dirty. */
function makeRepoWithWorktree(root, worktree, branch) {
  const main = join(root, 'ref');
  mkdirSync(main, { recursive: true });
  git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 't@t']);
  git(main, ['config', 'user.name', 't']);
  git(main, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(main, 'a.txt'), 'one\n');
  git(main, ['add', '.']);
  git(main, ['commit', '-qm', 'init']);
  writeFileSync(join(main, 'a.txt'), 'two\n');
  git(main, ['worktree', 'add', '-q', '-b', branch, join(root, worktree)]);
  writeFileSync(join(root, worktree, 'a.txt'), 'three\n');
}

/** Resize the right pane until the long-name head is `target` px wide. */
async function setHeadWidth(page, target) {
  for (let i = 0; i < 3; i++) {
    const cur = await page.evaluate(() => {
      const head = [...document.querySelectorAll('.repo-head')].find(
        (h) => h.querySelector('.repo-head__name')?.textContent?.length > 30,
      );
      return {
        head: head.getBoundingClientRect().width,
        pane: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--right-w')),
      };
    });
    await page.evaluate(
      (w) => document.documentElement.style.setProperty('--right-w', `${w}px`),
      cur.pane - (cur.head - target),
    );
    await sleep(150);
  }
}

const measure = (page) =>
  page.evaluate(() => {
    const head = [...document.querySelectorAll('.repo-head')].find(
      (h) => h.querySelector('.repo-head__name')?.textContent?.length > 30,
    );
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const name = head.querySelector('.repo-head__name');
    const chip = head.querySelector('.branch-chip');
    return {
      head: box(head),
      chev: box(head.querySelector('.repo-head__chev')),
      name: box(name),
      nameEllipsized: name.scrollWidth > name.clientWidth,
      tag: box(head.querySelector('.repo-head__tag')),
      chip: box(chip),
      glyphs: [...chip.querySelectorAll('.branch-chip__glyph')].map((g) => ({
        ...box(g),
        parent: box(g.parentElement),
      })),
      labels: [...chip.querySelectorAll('.branch-chip__label')].map(box),
      sub: box(head.querySelector('.repo-head__sub')),
    };
  });

runScenario('repo-head-fit', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-headfit-'));
  makeRepoWithWorktree(root, LONG, 'feature/a-fairly-long-branch-name');

  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForFunction(
    (id) => ((window.__sessions || []).find((x) => x.id === id)?.repos?.length ?? 0) >= 2,
    sid,
    { timeout: 20000 },
  );
  await openChangesTab(page);
  await page.waitForFunction(
    (long) =>
      [...document.querySelectorAll('.repo-head')].some(
        (h) =>
          h.querySelector('.repo-head__name')?.textContent === long &&
          h.querySelector('.repo-head__sub') &&
          h.querySelector('.branch-chip:not(:disabled) .branch-chip__worktree'),
      ),
    LONG,
    { timeout: 20000 },
  );

  // Narrow, the default pane, and wide enough that the name fits whole with label room to spare.
  const seen = { whole: false, ellipsized: false };
  for (const width of [220, 330, 480]) {
    await setHeadWidth(page, width);
    const m = await measure(page);
    const at = `@${Math.round(m.head.width)}px`;
    const line = [m.chev, m.name, m.tag, m.chip];
    assert(
      line.every(Boolean) && m.sub,
      `${at} chevron, name, tag, chip and sub-path all render: ${JSON.stringify(m)}`,
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

    // 2. The name ellipsizes only once the chip has given up all its label text.
    const labelRoom = m.labels.reduce((a, b) => a + b.width, 0);
    assert(
      !m.nameEllipsized || labelRoom <= 0.5,
      `${at} name ellipsized while the chip still shows ${labelRoom}px of labels`,
    );

    // 3. The chip is never narrower than its glyphs, and no glyph is folded out of its own box.
    assert(
      m.glyphs.length === 2 &&
        m.glyphs.every(
          (g) => g.width > 0 && g.left >= m.chip.left && g.right <= m.chip.right + 0.5,
        ),
      `${at} chip ${JSON.stringify(m.chip)} holds its glyphs ${JSON.stringify(m.glyphs)}`,
    );
    assert(
      m.glyphs.every((g) => g.left >= g.parent.left - 0.5 && g.right <= g.parent.right + 0.5) &&
        m.glyphs[0].right <= m.glyphs[1].left,
      `${at} each glyph keeps its own room: ${JSON.stringify(m.glyphs)}`,
    );
    assert(
      m.chip.right <= m.head.right + 0.5,
      `${at} chip stays inside the head: ${m.chip.right} vs ${m.head.right}`,
    );
    seen[m.nameEllipsized ? 'ellipsized' : 'whole'] = true;
    if (!m.nameEllipsized) {
      assert(labelRoom > 0, `${at} a whole name leaves the chip room for its labels`);
    }
    log(
      `${at} one line above sub-path; name ${m.nameEllipsized ? 'ellipsized' : 'whole'}, chip ${Math.round(
        m.chip.width,
      )}px (labels ${Math.round(labelRoom)}px) ✓`,
    );
  }
  assert(
    seen.whole && seen.ellipsized,
    `both a whole and an ellipsized name were measured: ${JSON.stringify(seen)}`,
  );
});
