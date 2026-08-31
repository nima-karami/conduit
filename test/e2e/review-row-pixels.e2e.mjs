/**
 * Review row contrast on REAL composited pixels, once per theme (spec 2026-08-31-review-fidelity
 * §3, AC-T2.1 / AC-T2.2 / blockers Q1 and Q7).
 *
 * Why it launches per theme rather than poking `data-theme`: the diff body's surface comes from
 * the SETTINGS' `surfaceColor`, not from `--code-base`, so a theme poke moves the row wash while
 * leaving the surface under it where the profile booted — and a hidden window's compositor tiles
 * do not re-render for a live theme swap either. Both hazards go away by seeding the theme into a
 * fresh profile. Launches are strictly sequential: one Electron at a time (CLAUDE.md's load rule).
 *
 * BLOCKERS Q7, answered here. The diagnosis found some Neon added rows sampling ~+6 on every
 * channel above the arithmetic composite and could not place it. It is `.theatre`
 * (`styles.css` ~6478): a fixed, pointer-transparent film over the WHOLE app at `z-index: 300`,
 * lit only on Neon (`--theatre: 1`) — a repeating scanline of 2 px transparent then 1 px of white
 * at 0.028, under a slowly sweeping gradient peaking at 0.022. 255 x 0.028 = 7.1, which is the
 * "+6/+7 on every channel"; the 1-in-3 scanline pitch against an 18.59 px row is why only SOME
 * rows showed it; and the sweep is animated, which is why the exact value drifts between runs.
 * So the film IS a real second surface and gets asserted as one — but it films the changed row
 * and the unchanged row beside it identically, so it never sits between them.
 *
 * Each theme is therefore sampled twice: once as shipped (every row must land inside the film's
 * envelope and nowhere else), and once with `--theatre` dialled to 0 (every row must equal its
 * token composite exactly, which is what the unit-test model claims). The floors are asserted on
 * the second, and on the filmed surface analytically in `test/unit/diff-tokens.test.ts`.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` first. Close via closeApp.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession } from './harness.mjs';
import { decodePng, hex, pxAt } from './png.mjs';
import { contrast, installRowProbe, toHex } from './row-color.mjs';

const THEMES = ['aero-dark', 'aero', 'neon'];

const V1 = ['const greeting = "hello world";', 'function old() {', '  return 1;', '}', ''].join(
  '\n',
);
const V2 = [
  '// a friendly greeting',
  'const greeting = "hello there";',
  'function shiny(count: number): number {',
  '  return count * 2;',
  '}',
  '',
].join('\n');

const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch', 'rf');
const log = makeLog('review-row-pixels');

const ch = (s) => [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
const near = (a, b, tol) => ch(a).every((v, i) => Math.abs(v - ch(b)[i]) <= tol);
/** `c` lifted by a white film at `alpha` — what `.theatre` does to whatever is under it. */
const filmed = (c, alpha) => toHex(ch(c).map((v) => 255 * alpha + v * (1 - alpha)));
/** Every channel of `got` is between `lo` and `hi` (inclusive, with 1/255 of compositor slack). */
const between = (got, lo, hi) => ch(got).every((v, i) => v >= ch(lo)[i] - 1 && v <= ch(hi)[i] + 1);

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-rowpx-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'app.ts'), V1);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  writeFileSync(join(dir, 'app.ts'), V2);
  return dir;
}

function seedProfile(theme) {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-ud-'));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ version: 1, settings: { theme, restoreSessions: false } }),
  );
  return dir;
}

/** Row rects, kinds, and the right edge of the widest glyph run, so a scan can pick a band that
 *  holds no text on ANY row — an antialiased glyph halo is a colour of its own and would be read
 *  as a surface. */
const readGeometry = () => {
  const card = document.querySelector('.review .rcard[data-path="app.ts"]');
  const rows = [...card.querySelectorAll('.rline')];
  const rs = rows.map((r) => r.getBoundingClientRect());
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return {
    clip: {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(...rs.map((r) => r.right)) - x,
      height: Math.max(...rs.map((r) => r.bottom)) - y,
    },
    rows: rows.map((r, i) => ({
      kind: r.className.includes('--add') ? 'add' : r.className.includes('--del') ? 'del' : 'ctx',
      cy: rs[i].y + rs[i].height / 2 - y,
    })),
    textRight: Math.max(
      ...rows.map((r) => {
        const t = r.querySelector('.rline__text');
        if (!t?.firstChild) return 0;
        const range = document.createRange();
        range.selectNodeContents(t);
        return range.getBoundingClientRect().right - x;
      }),
    ),
  };
};

/** Per-row dominant background (in a text-free band) and leading-edge pixel. */
async function sample(page, geom, path) {
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path, clip: geom.clip });
  const img = decodePng(readFileSync(path));
  // Skip the leading 4 px — that column is the edge accent, which is SUPPOSED to differ.
  const from = Math.min(img.w - 8, Math.ceil(geom.textRight) + 3);
  return geom.rows
    .map((r) => ({ kind: r.kind, y: Math.round(r.cy) }))
    .filter((r) => r.y >= 0 && r.y < img.h)
    .map((r) => {
      const counts = new Map();
      for (let x = from; x < img.w; x++) {
        const px = hex(pxAt(img, x, r.y));
        counts.set(px, (counts.get(px) ?? 0) + 1);
      }
      const [px, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        kind: r.kind,
        bg: px,
        pct: Math.round((n / (img.w - from)) * 100),
        edge: hex(pxAt(img, 1, r.y)),
      };
    });
}

async function measure(theme, root) {
  const launched = await launchApp({ userDataDir: seedProfile(theme) });
  const { app, page } = launched;
  try {
    await openSession(page, { path: root.replace(/\\/g, '/') });
    await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
    await page.click('.git-indicator__review');
    await page.waitForFunction(
      () => {
        const c = document.querySelector('.review .rcard[data-path="app.ts"]');
        return !!c && !/Loading diff/i.test(c.textContent ?? '') && !!c.querySelector('.rline');
      },
      null,
      { timeout: 20000 },
    );
    const booted = await page.evaluate(() => document.documentElement.dataset.theme || 'aero-dark');
    assert(booted === theme, `profile should have booted on ${theme}; got ${booted}`);

    await installRowProbe(page);
    const tokens = await page.evaluate(() =>
      window.__conduitRowProbe(document.querySelector('.review .rcard[data-path="app.ts"]')),
    );
    // The film's own numbers, read off the live rule rather than hardcoded, so a re-tune of
    // `.theatre` surfaces here rather than as a mystery pixel two runs later.
    const film = await page.evaluate(() => {
      const el = document.querySelector('.theatre');
      if (!el) return { scanline: 0, sweep: 0 };
      const opacity = Number(getComputedStyle(el).opacity);
      const alpha = (s) => {
        const m = /rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/.exec(s);
        return m ? opacity * Number(m[1]) : 0;
      };
      return {
        scanline: alpha(getComputedStyle(el).backgroundImage),
        sweep: alpha(getComputedStyle(el, '::after').backgroundImage),
      };
    });

    const geom = await page.evaluate(readGeometry);
    const lit = await sample(page, geom, join(shotDir, `rows-${theme}.png`));
    // Dial the film out. `--theatre` scales opacity AND the sweep duration, so at 0 the layer
    // paints nothing at all — the stylesheet's own documented behaviour, not a test-only hook.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--theatre', '0');
    });
    const bare = await sample(page, geom, join(shotDir, `rows-${theme}-nofilm.png`));

    log(`${theme}: film=${JSON.stringify(film)}`);
    log(`${theme} as shipped:  ${JSON.stringify(lit)}`);
    log(`${theme} film dialled to 0: ${JSON.stringify(bare)}`);
    return { theme, tokens, film, lit, bare };
  } finally {
    await closeApp(app, page).catch(() => {});
    await launched.cleanup().catch(() => {});
  }
}

async function main() {
  const root = makeRepo();
  const results = [];
  for (const theme of THEMES) results.push(await measure(theme, root));

  for (const { theme, tokens, film, lit, bare } of results) {
    const modelled = {
      add: toHex(tokens.addRow),
      del: toHex(tokens.delRow),
      ctx: toHex(tokens.ctxRow),
    };
    const maxAlpha = film.scanline + film.sweep;

    // With the film dialled out, the compositor and the token arithmetic must agree exactly —
    // this is the claim the unit-test model rests on. 1/255 of slack for rounding.
    for (const row of bare) {
      assert(
        near(row.bg, modelled[row.kind], 1),
        `${theme}: with no film, a ${row.kind} row sampled ${row.bg} but the tokens composite to ${modelled[row.kind]}`,
      );
    }

    // As shipped, every row must land inside the film's envelope and NOWHERE else. A genuine
    // per-row wash — a hover state, a current-hunk band — would put a row outside it.
    for (const row of lit) {
      assert(
        between(row.bg, modelled[row.kind], filmed(modelled[row.kind], maxAlpha)),
        `${theme}: a ${row.kind} row sampled ${row.bg}, outside the ${modelled[row.kind]}..${filmed(modelled[row.kind], maxAlpha)} film envelope — that is a surface nothing accounts for`,
      );
    }

    // AC-T2.1, on the film-free pixels. (The floors under the film are asserted analytically in
    // test/unit/diff-tokens.test.ts, where the worst pairing can be enumerated.)
    const crAdd = contrast(ch(modelled.add), ch(modelled.ctx));
    const crDel = contrast(ch(modelled.del), ch(modelled.ctx));
    log(
      `${theme}: add ${modelled.add} ${crAdd}:1 · del ${modelled.del} ${crDel}:1 · ctx ${modelled.ctx}`,
    );
    // 1.295 / 1.125 is 1.30 / 1.14 at the 2 dp the criterion is published in.
    assert(crAdd >= 1.295, `${theme}: added row is only ${crAdd}:1 against an unchanged row`);
    assert(crDel >= 1.125, `${theme}: deleted row is only ${crDel}:1 against an unchanged row`);

    // Blockers Q1's edge accent, on real pixels: the leading column of a changed row carries the
    // change hue, an unchanged row carries nothing.
    const hueOf = (raw) =>
      toHex(
        raw
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number),
      );
    for (const kind of ['add', 'del']) {
      const want = hueOf(kind === 'add' ? tokens.changeAdded : tokens.changeDeleted);
      const bars = bare.filter((r) => r.kind === kind).map((r) => r.edge);
      assert(
        bars.length > 0 && bars.every((b) => near(b, want, 1)),
        `${theme}: a ${kind} row's leading edge must paint ${want}; got ${bars.join(', ')}`,
      );
      // Far brighter than the 1.14:1 fill step it supplements — that is the whole point of it.
      assert(
        bars.every((b) => contrast(ch(b), ch(modelled[kind])) >= 3),
        `${theme}: the ${kind} edge accent must clear 3:1 against its own row; got ${bars.join(', ')}`,
      );
    }
    assert(
      bare.filter((r) => r.kind === 'ctx').every((r) => near(r.edge, modelled.ctx, 1)),
      `${theme}: an unchanged row must have no edge accent`,
    );
  }
  log(`screenshots under ${shotDir}`);
  log('PASS ✓');
}

if (process.platform !== 'win32') {
  console.log('[review-row-pixels] SKIP — suite is Windows-only (non-win32 platform)');
  process.exit(0);
}

main().then(
  () => process.exit(0),
  (e) => {
    if (e?.name === 'AssertionError') {
      log('FAIL ✗', e.message);
      process.exit(1);
    }
    console.error('[review-row-pixels] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    process.exit(2);
  },
);
