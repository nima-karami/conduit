/**
 * Text-fit sweep — drives every surface of the REAL built app under stress content (see
 * text-fit-fixture.mjs) and runs the text-fit detector (text-fit.mjs) on each frame.
 *
 *   npm run build          (then `npm run text-fit -- <flags>` is the same as the lines below)
 *   node test/e2e/visual/text-fit-sweep.mjs --out=<dir> --theme=aero --size=1320x820,1000x700
 *   node test/e2e/visual/text-fit-sweep.mjs --out=<dir> --theme=all --panels=both rail tabs
 *   node test/e2e/visual/text-fit-sweep.mjs --out=<after> --recrop=<before>/findings.json
 *
 * Per pass (`<theme>-<W>x<H>-<panels>`): `<out>/<pass>/<shot>.png` full frames and
 * `<pass>/findings.json`; every finding is cropped to `<out>/crops/<id>.png`, and
 * `<out>/findings.json` merges every pass present in `<out>`. `--panels=min` drags the sessions
 * rail and the right pane to their minimum widths first — where overflow bugs live.
 *
 * `--recrop=<findings.json>` re-crops every finding in that file at ITS stored clip rect, for the
 * pass/shot it came from, into `<out>/crops/<id>.png` — so a BEFORE and an AFTER crop of the same
 * id are the same pixels of the window. Passes, scenes and sizes default to the ones that file
 * covers. Finding ids hash `pass|shot|kind|path|text|counterpart`, so an unfixed finding keeps
 * its id. A run of a scene subset replaces only the shots it re-took in that pass's findings.json.
 * Findings confirmed by eye that the detector cannot see go in `<out>/eye-findings.json` (same
 * shape, with a hand-picked `clip`); the merge carries them, so a re-crop covers them too.
 *
 * Shares shoot.mjs's rules: hidden window, theme pre-seeded into settings.json (an in-app switch
 * leaves a hidden window's compositor on the previous theme), one app at a time, closeApp.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeApp,
  launchApp,
  openChangesTab,
  openHistory,
  openReview,
  tapBridge,
} from '../harness.mjs';
import { auditTextFit, cropFinding } from './text-fit.mjs';
import { buildStressFixture, NOSPACE_FILE } from './text-fit-fixture.mjs';

const THEMES = ['aero', 'aero-dark', 'neon'];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const outDir = flag('out', join(tmpdir(), 'claude-scratch', 'text-fit-sweep'));
const recropFile = flag('recrop', '');
const recrop = recropFile ? JSON.parse(readFileSync(recropFile, 'utf8')) : null;
const recropPasses = recrop ? [...new Set(recrop.map((f) => f.pass))] : [];
const themeArg = flag('theme', '');
const sizeArg = flag('size', '');
const panelsArg = flag('panels', '');
const wanted = argv.filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

const LONG_PROJECT = 'Customer Reservation Platform — Booking Experience Modernization Initiative';
const OTHER_PROJECT = 'Überprüfung und Wartung — 予約確認プロジェクト with a long trailing name';
const SESSION_TITLES = [
  'Refactor the booking confirmation summary component and its snapshot tests for multi-leg trips',
  'Supercalifragilisticexpialidocious_session_title_without_spaces_to_break_on',
  'Überprüfung — 予約確認の概要 idle session in a plain folder',
  'Linked to the booking confirmation card with a session name that runs long',
];
const TIMED_TEXT =
  'continue with the migration plan and when finished run the full verify gate then summarise every failing check';

// ── scenes ───────────────────────────────────────────────────────────────────
// Each scene gets the ctx built in runPass and calls `ctx.shot(name)` for every frame it wants
// audited. Scenes leave no overlay behind (ctx.dismiss) — the next one would shoot through it.

const SCENES = {
  async rail(c) {
    await c.shot('rail');
    await c.rightClickSel('.session');
    await c.shot('ctx-session');
    await c.dismiss();
    await c.rightClickSel('.proj__name');
    await c.shot('ctx-project');
    await c.dismiss();
  },

  async tabs(c) {
    const files = [
      NOSPACE_FILE,
      'booking-confirmation-summary.ts',
      'résumé-überprüfung',
      'booking-confirmation-summary-variant-1',
      'booking-confirmation-summary-variant-2',
      'booking-confirmation-summary-variant-3',
      'Ünïcödé',
    ];
    for (const f of files) await c.quickOpen(f, { pin: true });
    await c.shot('tabs');
    await c.rightClickSel('.tab--active');
    await c.shot('ctx-tab');
    await c.dismiss();
    await c.page.click('.omnibar');
    await sleep(500);
    await c.type('booking-confirmation');
    await sleep(1400);
    await c.shot('quick-open');
    await c.dismiss();
  },

  async files(c) {
    await c.quickOpen(NOSPACE_FILE);
    await c.showRightTab('Files');
    await sleep(1500);
    // Reveal expands the deep chain down to the open file.
    await c.page.evaluate(() => {
      document.querySelector('.tab--active')?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 60,
        }),
      );
    });
    await sleep(600);
    const revealed = await c.clickMenuItem(/Reveal in (Files|Explorer|tree)/i);
    if (!revealed) await c.dismiss();
    await sleep(1500);
    await c.shot('files');
    await c.rightClickSel('.filerow');
    await c.shot('ctx-explorer');
    await c.dismiss();
  },

  async search(c) {
    await c.page.keyboard.press('Control+Shift+F');
    await sleep(800);
    await c.type('summaryForTheLongestPossibleItineraryVariant');
    await sleep(3000);
    await c.shot('search');
  },

  async changes(c) {
    await openChangesTab(c.page);
    await c.page
      .waitForFunction(() => document.querySelectorAll('.repo-head').length >= 2, null, {
        timeout: 20_000,
      })
      .catch(() => {});
    await sleep(2000);
    await c.shot('changes');
    await c.page.click('.branch-chip').catch(() => {});
    await sleep(900);
    await c.shot('menu-branch-chip');
    await c.dismiss();
    const picker = await c.page.$('.repo-head__picker');
    if (picker) {
      await picker.click();
      await sleep(900);
      await c.shot('menu-repo-picker');
      await c.dismiss();
    }
    await c.rightClickSel('.change');
    await c.shot('ctx-change');
    await c.dismiss();
  },

  async history(c) {
    await openHistory(c.page);
    await sleep(3000);
    await c.shot('history');
    const rows = await c.page.$$('.gh__row, .gh__node-head, .gh__subject');
    if (rows[1]) {
      await rows[1].click();
      await sleep(2500);
      await c.shot('history-detail');
    }
  },

  async review(c) {
    await openReview(c.page);
    await c.page.waitForSelector('.review__head', { state: 'visible', timeout: 20000 });
    await sleep(4000);
    await c.shot('review');
    // The commit source is disabled under "All repos"; scoping to one repo enables it.
    if (await c.page.$('.review__chip')) {
      await c.page.click('.review__chip');
      await sleep(1200);
      await c.shot('menu-review-repo');
      const items = c.page.locator('.ctxmenu [role="menuitem"], .ctxmenu .ctxmenu__item');
      if ((await items.count()) > 1) await items.nth(1).click();
      else await c.dismiss();
      await sleep(2500);
      await c.shot('review-one-repo');
    }
    const src = c.page.locator('.review__source');
    if ((await src.count()) && (await src.isEnabled())) {
      await src.click();
      await sleep(1500);
      await c.shot('menu-commit-picker');
      const rows = c.page.locator('.commit-picker__row');
      if ((await rows.count()) > 1) {
        await rows.nth(1).click();
        await sleep(3500);
        await c.shot('review-commit');
      } else await c.dismiss();
    }
    await c.page.click('.tab[data-tabid="__terminal__"]').catch(() => {});
    await sleep(800);
  },

  async board(c) {
    await c.view('Feature Board');
    await sleep(2500);
    await c.shot('board');
    await c.view('Editor');
    await sleep(800);
  },

  async canvas(c) {
    await c.view('Architecture Canvas');
    await sleep(3000);
    await c.page.evaluate(
      (p) => window.agentDeck.post({ type: 'requestArchitecture', path: p }),
      c.repo,
    );
    await sleep(2500);
    await c.shot('canvas');
    await c.view('Editor');
    await sleep(800);
  },

  async 'new-session'(c) {
    await c.page.click('[aria-label="New session"]');
    await sleep(2500);
    await c.shot('new-session');
    await c.dismiss();
  },

  async settings(c) {
    await c.page.click('.footbtn');
    await sleep(1500);
    const items = await c.page.$$eval('.settings__navitem', (els) =>
      els.map((e) => e.textContent.trim()),
    );
    for (const [i, label] of items.entries()) {
      await c.page.evaluate((n) => document.querySelectorAll('.settings__navitem')[n]?.click(), i);
      await sleep(900);
      await c.shot(`settings-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    }
    await c.dismiss();
  },

  async palette(c) {
    await c.page.click('.omnibar');
    await sleep(900);
    await c.shot('palette-sessions');
    await c.type('>');
    await sleep(1000);
    await c.shot('palette-commands');
    await c.dismiss();
  },

  async monaco(c) {
    await c.quickOpen('booking-confirmation-summary-variant-1');
    await sleep(3000);
    const token = await c.tokenBox('computeBookingConfirmation', 1);
    if (!token) throw new Error('monaco: identifier not on screen');
    await c.page.mouse.move(token.x, token.y);
    await sleep(2500);
    await c.shot('monaco-hover');
    await c.page.mouse.move(5, 400);
    await sleep(600);
    await c.page.mouse.click(token.x, token.y);
    await sleep(400);
    await c.page.keyboard.press('Shift+F12');
    await sleep(4000);
    await c.shot('monaco-peek');
    await c.page.keyboard.press('Escape');
    await sleep(600);
    // Suggest: an empty line at the end, then a prefix with many long completions.
    await c.page.keyboard.press('Control+End');
    await c.page.keyboard.press('Enter');
    await c.type('summary.');
    await c.page.keyboard.press('Control+Space');
    await sleep(2500);
    await c.shot('monaco-suggest');
    await c.page.keyboard.press('Escape');
    await c.page.keyboard.press('Control+z');
    await c.page.keyboard.press('Control+z');
    await c.page.keyboard.press('Control+f');
    await sleep(400);
    await c.type('reservationIdentifierForCustomerFacingCommunication');
    await sleep(1200);
    await c.shot('monaco-find');
    await c.page.keyboard.press('Escape');
  },

  async markdown(c) {
    await c.quickOpen('ARCHITECTURE-DECISIONS');
    await sleep(3000);
    await c.shot('markdown');
    const outline = c.page.locator('.viewer__controls button, .viewer button', {
      hasText: 'Outline',
    });
    if (await outline.count()) {
      await outline.first().click();
      await sleep(1500);
      await c.shot('markdown-toc');
      // The outline is a toggle, not a dismiss-on-outside popover: left open it sits over
      // every later scene.
      await outline.first().click();
      await sleep(600);
    }
  },

  async plan(c) {
    writeFileSync(c.fixture.plan.file, c.fixture.plan.body);
    const toast = c.page.locator('.toast', { hasText: 'Agent updated plan' }).first();
    const toasted = await toast
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (toasted) {
      await c.shot('toast-plan');
      await toast.locator('.toast__action', { hasText: 'Open' }).click();
    } else {
      // The external-write toast does not fire for this fixture (not diagnosed); the plan view
      // itself is still reachable by opening the file.
      console.log('  ! plan: no "Agent updated plan" toast — opening the plan file directly');
      await c.quickOpen('migrate-the-reservation-service');
    }
    await sleep(3500);
    await c.shot('plan');
  },

  /** The timed-message dialog with a long armed row, then that row fired early → its toast. */
  async timed(c) {
    await c.page.click(`.session[data-sessionid="${c.sessions[0]}"]`).catch(() => {});
    await sleep(1200);
    await c.rightClickSel(`.session[data-sessionid="${c.sessions[0]}"]`);
    if (!(await c.clickMenuItem(/timed message/i))) {
      await c.dismiss();
      throw new Error('timed: no menu item');
    }
    await sleep(1200);
    await c.page.click('.tmdlg__input');
    await c.page.keyboard.press('Control+A');
    await c.type(TIMED_TEXT);
    await sleep(400);
    await c.shot('timed-dialog');
    await c.page.locator('.tmdlg .btn--primary', { hasText: 'Arm' }).click();
    await sleep(1200);
    // Arm closes the dialog; reopen it to see the armed row.
    if (!(await c.page.$('.tmdlg'))) {
      await c.rightClickSel(`.session[data-sessionid="${c.sessions[0]}"]`);
      await c.clickMenuItem(/timed message/i);
      await sleep(1200);
    }
    await c.shot('timed-armed');
    await c.page.evaluate(() => document.querySelector('.tmdlg__close')?.click());
    await sleep(600);
    await c.page.evaluate(() =>
      window.agentDeck.post({ type: 'timer:test', op: 'advance', ms: 31 * 60_000 }),
    );
    await c.page
      .locator('.toast')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await sleep(600);
    await c.shot('toast');
    await c.page.click('.toast__close').catch(() => {});
    await sleep(400);
  },

  async confirm(c) {
    await c.page.click('.tab[data-tabid="__terminal__"]').catch(() => {});
    await openChangesTab(c.page);
    await sleep(1200);
    await c.rightClickSel('.change');
    const ok = await c.clickMenuItem(/discard/i);
    if (!ok) {
      await c.dismiss();
      throw new Error('confirm: no Discard item');
    }
    await sleep(900);
    await c.shot('confirm');
    // Cancel — never actually discard: later scenes need the dirty tree.
    await c.page
      .locator('.confirm .btn', { hasText: /cancel/i })
      .first()
      .click()
      .catch(() => {});
    await sleep(500);
  },
};

const DEFAULT_ORDER = [
  'rail',
  'tabs',
  'files',
  'search',
  'changes',
  'history',
  'review',
  'board',
  'canvas',
  'new-session',
  'settings',
  'palette',
  'monaco',
  'markdown',
  'timed',
  'plan',
  'confirm',
];

/**
 * Jump every finite CSS animation/transition to its end state. A hidden window throttles frames,
 * so an entrance animation (a toast's fade-in) can sit at its first frames indefinitely and the
 * frame shows — and the detector skips — a half-transparent surface no user ever sees settled.
 */
const settle = (page) =>
  page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY) continue;
      try {
        a.finish();
      } catch {
        // An animation that cannot finish (no end time) keeps running; nothing to settle.
      }
    }
  });

// ── pass driver ──────────────────────────────────────────────────────────────

function seedProfile(theme) {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-textfit-ud-'));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ version: 1, settings: { theme, restoreSessions: false } }),
  );
  return dir;
}

async function runPass({ theme, width, height, panels }, sceneNames, fixture) {
  const pass = `${theme}-${width}x${height}-${panels}`;
  const dest = join(outDir, pass);
  const crops = join(outDir, 'crops');
  mkdirSync(dest, { recursive: true });
  mkdirSync(crops, { recursive: true });
  console.log(`[text-fit] pass ${pass}`);

  const { app, page } = await launchApp({
    env: { CONDUIT_E2E: '1' },
    userDataDir: seedProfile(theme),
  });
  const findings = [];
  const covered = [];

  const dismiss = async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.modal__backdrop')) el.click();
    });
    await page.mouse.click(2, height - 2).catch(() => {});
    await sleep(500);
  };
  const type = (t) => page.keyboard.type(t, { delay: 20 });
  const rightClickSel = async (sel) => {
    const el = await page.$(sel);
    if (!el) return false;
    const b = await el.boundingBox();
    if (!b) return false;
    await page.mouse.click(b.x + Math.min(40, b.width / 2), b.y + Math.min(12, b.height / 2), {
      button: 'right',
    });
    await sleep(900);
    return true;
  };
  const clickMenuItem = async (re) => {
    const items = page.locator('.ctxmenu__item, [role="menuitem"]');
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const t = (await items.nth(i).textContent()) ?? '';
      if (re.test(t)) {
        await items.nth(i).click();
        return true;
      }
    }
    return false;
  };
  const quickOpen = async (q, { pin = false } = {}) => {
    await page.click('.omnibar');
    await sleep(500);
    await type(q);
    await sleep(1400);
    await page.keyboard.press('Enter');
    await sleep(2000);
    // Quick open lands in the single preview tab; a many-tabs strip needs each one pinned.
    if (pin) await page.dblclick('.tab--preview').catch(() => {});
  };
  const showRightTab = async (label) => {
    if (!(await page.isVisible('.rightpane'))) await page.keyboard.press('Control+Shift+E');
    await page.evaluate((l) => {
      [...document.querySelectorAll('.rtab')]
        .find((e) => e.textContent.trim().startsWith(l))
        ?.click();
    }, label);
    await sleep(800);
  };
  const view = (title) =>
    page.evaluate((t) => document.querySelector(`.viewswitch__btn[title="${t}"]`)?.click(), title);
  const tokenBox = (text, nth = 0) =>
    page.evaluate(
      ({ t, n }) => {
        // Only a token whose first glyphs are inside the editor's viewport: at narrow widths the
        // later occurrences sit past the horizontal scroll, and a click there hits the minimap.
        const view = document.querySelector('.monaco-editor .lines-content')?.parentElement;
        const vr = view?.getBoundingClientRect();
        const hits = [...document.querySelectorAll('.monaco-editor .view-lines span span')]
          .filter((s) => s.textContent.includes(t))
          .map((s) => s.getBoundingClientRect())
          .filter((r) => !vr || (r.left + 20 < vr.right && r.left >= vr.left));
        const r = hits[n] ?? hits[0];
        return r ? { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 } : null;
      },
      { t: text, n: nth },
    );

  const recropFor = (shotName) =>
    (recrop ?? []).filter((f) => f.pass === pass && f.shot === shotName && f.clip);

  const shot = async (name) => {
    await sleep(300);
    await settle(page);
    await page.screenshot({ path: join(dest, `${name}.png`), scale: 'css' });
    covered.push(name);
    let found = [];
    try {
      found = await auditTextFit(page);
    } catch (e) {
      console.log(`  ! audit failed on ${name}: ${e.message}`);
    }
    for (const f of found) {
      const id = `${pass}__${name}__${f.kind}__${hash(`${f.path}|${f.text}|${f.detail?.other ?? ''}`)}`;
      const clip = await cropFinding(page, f, join(crops, `${id}.png`));
      findings.push({ id, pass, shot: name, source: 'detector', ...f, clip });
    }
    for (const f of recropFor(name)) {
      await page.screenshot({ path: join(crops, `${f.id}.png`), clip: f.clip, scale: 'css' });
    }
    console.log(`  ${pass}/${name}.png  (${found.length} finding${found.length === 1 ? '' : 's'})`);
  };

  const sessions = [];
  try {
    await app.evaluate(
      (electron, s) => electron.BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h),
      { w: width, h: height },
    );
    await tapBridge(page);
    await sleep(1200);

    const project = async (name) => {
      const before = await page.evaluate(() => (window.__projects || []).map((p) => p.id));
      await page.evaluate(
        (n) => window.agentDeck.post({ type: 'project:create', name: n, requestId: Date.now() }),
        name,
      );
      return page
        .waitForFunction(
          (a) =>
            (window.__projects || []).find((p) => p.name === a.n && !a.ids.includes(p.id))?.id ||
            null,
          { n: name, ids: before },
          { timeout: 10_000 },
        )
        .then((h) => h.jsonValue());
    };
    const open = async (opts) => {
      const before = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));
      await page.evaluate(
        (o) => window.agentDeck.post({ type: 'openRepo', agentId: 'shell:pwsh', ...o }),
        opts,
      );
      const id = await page
        .waitForFunction(
          (ids) => (window.__sessions || []).find((s) => !ids.includes(s.id))?.id || null,
          before,
          { timeout: 25_000 },
        )
        .then((h) => h.jsonValue());
      await sleep(3000);
      return id;
    };
    const selectCard = async (id) => {
      await page.click(`.session[data-sessionid="${id}"]`).catch(() => {});
      await sleep(2500);
    };
    const feed = (id, data) =>
      page.evaluate(
        (a) => window.agentDeck.post({ type: 'term:input', sessionId: a.id, data: a.d }),
        {
          id,
          d: data,
        },
      );

    const p1 = await project(LONG_PROJECT);
    const p2 = await project(OTHER_PROJECT);
    sessions.push(await open({ path: fixture.repo, roots: [fixture.attached], projectId: p1 }));
    sessions.push(await open({ path: fixture.attached, projectId: p1 }));
    sessions.push(await open({ path: fixture.plain, projectId: p2 }));
    // Linked to board card c5, which lives on the home repo's board — a card only lists the
    // sessions of its own project root.
    sessions.push(await open({ path: fixture.repo, projectId: p1, cardId: 'c5' }));
    for (const [i, id] of sessions.entries()) {
      await page.evaluate((a) => window.agentDeck.post({ type: 'rename', id: a.id, name: a.n }), {
        id,
        n: SESSION_TITLES[i],
      });
    }
    // States: session 2 is Busy; session 3 (a clean folder, so it cannot settle as Review) earns
    // Needs-you — its command finishes after the focus has moved away.
    await selectCard(sessions[1]);
    await feed(sessions[1], 'while ($true) { Get-Date; Start-Sleep -Milliseconds 400 }\r');
    await selectCard(sessions[2]);
    await feed(sessions[2], 'Start-Sleep -Seconds 2; Get-ChildItem\r');
    await sleep(400);
    await selectCard(sessions[0]);
    await feed(sessions[0], `git status --short; git branch --show-current\r`);
    await sleep(2500);

    if (panels === 'min') {
      for (const sel of ['.panel__resize--right', '.panel__resize--left']) {
        const handles = await page.$$(sel);
        for (const h of handles) {
          const b = await h.boundingBox();
          if (!b) continue;
          const x = b.x + b.width / 2;
          const y = b.y + b.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          // Toward the panel shrinks it: a right-edge handle belongs to a left panel.
          await page.mouse.move(sel.endsWith('right') ? x - 600 : x + 600, y, { steps: 8 });
          await page.mouse.up();
          await sleep(400);
        }
      }
      const widths = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return `${s.getPropertyValue('--left-w')} / ${s.getPropertyValue('--right-w')}`;
      });
      console.log(`  panels at min: ${widths}`);
    }

    const ctx = {
      page,
      app,
      shot,
      dismiss,
      type,
      rightClickSel,
      clickMenuItem,
      quickOpen,
      showRightTab,
      view,
      tokenBox,
      sessions,
      repo: fixture.repo,
      fixture,
    };
    for (const name of sceneNames) {
      const scene = SCENES[name];
      if (!scene) {
        console.log(`  ! unknown scene "${name}" — known: ${Object.keys(SCENES).join(', ')}`);
        continue;
      }
      try {
        await scene(ctx);
      } catch (e) {
        console.log(`  ! scene "${name}" failed: ${e.message.split('\n')[0]}`);
        await dismiss().catch(() => {});
      }
    }
  } finally {
    // A run of a scene subset replaces only the shots it re-took; the pass's other shots stay.
    const file = join(dest, 'findings.json');
    const kept = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8')).filter((f) => !covered.includes(f.shot))
      : [];
    writeFileSync(file, JSON.stringify([...kept, ...findings], null, 2));
    await closeApp(app, page).catch(() => {});
    await app.close().catch(() => {});
  }
  return { pass, covered, count: findings.length };
}

// ── main ─────────────────────────────────────────────────────────────────────

if (process.platform !== 'win32') {
  console.log('[text-fit] SKIP — Windows-only (the app ships Windows-only today)');
  process.exit(0);
}

const parsePass = (p) => {
  const m = p.match(/^(.+)-(\d+)x(\d+)-(default|min)$/);
  return m ? { theme: m[1], width: Number(m[2]), height: Number(m[3]), panels: m[4] } : null;
};

let passes;
if (recrop && !themeArg && !sizeArg && !panelsArg) {
  passes = recropPasses.map(parsePass).filter(Boolean);
} else {
  const themes = themeArg === 'all' ? THEMES : [themeArg || 'aero'];
  const sizes = (sizeArg || '1320x820').split(',').map((s) => s.split('x').map(Number));
  const panelModes = panelsArg === 'both' ? ['default', 'min'] : [panelsArg || 'default'];
  passes = themes.flatMap((theme) =>
    sizes.flatMap(([width, height]) =>
      panelModes.map((panels) => ({ theme, width, height, panels })),
    ),
  );
}
const scenes = wanted.length ? wanted : DEFAULT_ORDER;

console.log(`[text-fit] ${passes.length} pass(es) × ${scenes.length} scene(s) → ${outDir}`);
mkdirSync(outDir, { recursive: true });
const results = [];
for (const p of passes) {
  const fixture = buildStressFixture();
  results.push(await runPass(p, scenes, fixture));
}

// Merge every pass present in <out>, not only this run's — passes are run one invocation at a
// time as often as all at once.
const merged = [];
const eye = join(outDir, 'eye-findings.json');
if (existsSync(eye)) merged.push(...JSON.parse(readFileSync(eye, 'utf8')));
for (const d of readdirSync(outDir, { withFileTypes: true })) {
  const f = join(outDir, d.name, 'findings.json');
  if (d.isDirectory() && existsSync(f)) merged.push(...JSON.parse(readFileSync(f, 'utf8')));
}
writeFileSync(join(outDir, 'findings.json'), JSON.stringify(merged, null, 2));
for (const r of results)
  console.log(`[text-fit] ${r.pass}: ${r.covered.length} shots, ${r.count} findings`);
console.log(`[text-fit] merged ${merged.length} findings → ${join(outDir, 'findings.json')}`);
