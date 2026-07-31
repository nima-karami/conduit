/**
 * Visual verification harness — drives the REAL built app and captures what a user would see.
 *
 *   node test/e2e/visual/shoot.mjs                       # every scene, current default theme
 *   node test/e2e/visual/shoot.mjs --theme=neon review   # one scene, one theme
 *   node test/e2e/visual/shoot.mjs --theme=all workspace review
 *   node test/e2e/visual/shoot.mjs --out=C:/tmp/shots --size=1320x820
 *
 * Shots default to 1320×820 — the design frames' native size, so a capture and
 * `docs/design-handoff/revamp/frames/*.png` can be compared side by side at 1:1.
 *
 * Gotchas this encodes (each cost a debugging cycle):
 *   - The window launches hidden (CONDUIT_E2E=1). Visible windows steal focus and the
 *     quit-guard dialog hangs an unattended run.
 *   - The theme is pre-seeded into the profile's settings.json rather than clicked in the UI:
 *     a theme swap only mutates CSS custom properties, which does NOT invalidate a hidden
 *     window's cached compositor layers, so a screenshot taken after an in-app switch shows
 *     the PREVIOUS theme. Seeding means the first paint is already correct.
 *   - The git band renders over the terminal/review/history docs only — select the terminal
 *     tab before reaching for anything on it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp, launchApp } from '../harness.mjs';
import { ensureFixtureRepo } from './fixture-repo.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const THEMES = ['aero', 'aero-dark', 'neon'];

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const outDir = flag('out', join(HERE, '..', '..', '..', '.shots'));
const themeArg = flag('theme', '');
const [width, height] = flag('size', '1320x820').split('x').map(Number);
const wanted = argv.filter((a) => !a.startsWith('--'));

// ── scene registry ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Each scene gets `{ page, app, shot, click, clickText, type, key, repo, toTerminal }`
 * and captures one or more shots. Keep scene names stable — lanes cite them as evidence.
 */
const SCENES = {
  async workspace({ shot, term, sleep: nap }) {
    await term('git log --oneline -5\r');
    await nap(2500);
    await shot('workspace');
  },

  /**
   * The sessions rail with its states side by side. Nothing is faked: each card is a real
   * PTY driven into its state, so the shot shows what the derivation (src/session-icon.ts)
   * actually produces.
   *
   * Four of the five: Busy, Needs you, Review and Idle. **Stale** (a session that is not
   * running) is deliberately absent — every route to it from here was tried and none is
   * reliable: `exit` typed at a background shell is swallowed, `Stop-Process` on your own
   * shell stops at a Confirm prompt, and a `term:dispose` did not surface as an exit either.
   * Rather than ship a step whose comment lies about what it does, the state is left to
   * test/unit/session-icon.test.ts, which covers both not-running lifecycles.
   */
  async sessions({ page, shot, nap, repo }) {
    const post = (m) => page.evaluate((x) => window.agentDeck.post(x), m);
    const clickCard = (id) =>
      page.evaluate((i) => {
        document.querySelector(`.session[data-sessionid="${i}"]`)?.click();
      }, id);
    const feed = (id, data) => post({ type: 'term:input', sessionId: id, data });
    // A session's PTY starts on its pane's FIRST real visibility (terminal-pane.tsx starts on
    // fitIfVisible so it launches at the right size), so a card that has never been selected
    // has no process and swallows input silently. Select, let the shell come up, then type.
    const selectAndRun = async (id, cmd) => {
      await clickCard(id);
      await nap(2500);
      await feed(id, cmd);
    };

    // Two more in the fixture repo, one in a plain (non-git) folder — the clean folder is the
    // only way to see Idle, since a settled session in a dirty repo IS Review by D15. It has
    // to be a small EMPTY dir: opening a folder scans its tree, and %TEMP% itself is tens of
    // thousands of entries.
    const clean = join(tmpdir(), 'conduit-visual-clean').replace(/\\/g, '/');
    mkdirSync(clean, { recursive: true });
    for (const path of [repo, repo, clean]) {
      await post({ type: 'openRepo', path, agentId: 'shell:pwsh' });
      await nap(3000);
    }
    // Read the ids off the RENDERED cards, not the broadcast: the rail groups and sorts, so
    // list position in `state.sessions` is not card position, and driving the wrong session
    // is silent (you just get the wrong picture).
    const cards = await page.evaluate(() => {
      const path = Object.fromEntries((window.__sessions || []).map((s) => [s.id, s.projectPath]));
      return [...document.querySelectorAll('.session')].map((el) => ({
        id: el.dataset.sessionid,
        path: path[el.dataset.sessionid] ?? '',
      }));
    });
    const inFixture = cards
      .filter((c) => c.path.includes('conduit-visual-fixture'))
      .map((c) => c.id);
    const idle = cards.find((c) => c.path.includes('conduit-visual-clean'))?.id;
    const review = cards.find((c) => c.id !== idle && !inFixture.includes(c.id))?.id;
    const [needsYou, busy] = inFixture;
    if (!idle || !review || inFixture.length < 2) {
      throw new Error(`unexpected session set: ${JSON.stringify(cards)}`);
    }

    await clickCard(idle); // settles focused in a clean folder → Idle
    await nap(4000);

    await selectAndRun(review, 'git status --short\r'); // completedRun + a dirty repo → Review
    await nap(6000); // git status is not instant — settle BEFORE the focus moves away

    await selectAndRun(needsYou, 'git log --oneline -3\r'); // re-earn attention while unfocused
    await nap(400);
    await clickCard(busy);
    await nap(3000);

    await feed(busy, 'while ($true) { Get-Date; Start-Sleep -Milliseconds 150 }\r');
    await nap(2500);
    await shot('sessions');

    // Say what was actually achieved: a scene that silently produced three of the four
    // states would otherwise look identical to one that produced them all.
    const observed = await page.evaluate(() =>
      [...document.querySelectorAll('.session')].map(
        (el) => el.querySelector('.session__state')?.textContent ?? '?',
      ),
    );
    console.log(`  states on screen: ${observed.join(', ')}`);
    const statuses = await page.evaluate(() =>
      (window.__sessions || []).map((s) => `${s.status}${s.busy ? '/busy' : ''}`).join(' '),
    );
    console.log(`  host statuses: ${statuses}`);
  },

  async changes({ clickText, shot, nap }) {
    await clickText('.rtab', 'Changes');
    await nap(1500);
    await shot('changes');
  },

  async editor({ open, shot, nap }) {
    await open('app.tsx');
    await nap(2000);
    await shot('editor');
  },

  async markdown({ open, shot, nap }) {
    await open('CHANGELOG.md');
    await nap(2000);
    await shot('markdown');
  },

  async review({ toTerminal, click, shot, nap }) {
    await toTerminal();
    await click('.git-indicator__review');
    await nap(4000);
    await shot('review');
  },

  async history({ toTerminal, click, shot, nap }) {
    await toTerminal();
    await click('.git-indicator__history');
    await nap(4000);
    await shot('history');
  },

  async board({ click, shot, nap }) {
    await click('.viewswitch__btn[title="Feature Board"]');
    await nap(2500);
    await shot('board');
  },

  async canvas({ click, shot, nap }) {
    await click('.viewswitch__btn[title="Architecture Canvas"]');
    await nap(4000);
    await shot('canvas');
  },

  async settings({ click, clickText, shot, nap }) {
    await click('.footbtn');
    await nap(1500);
    await shot('settings-general');
    await clickText('.settings__navitem', 'Appearance');
    await nap(1500);
    await shot('settings-appearance');
  },

  async 'new-session'({ click, shot, nap }) {
    await click('[aria-label="New session"]');
    await nap(1500);
    await shot('new-session');
  },

  async 'session-menu'({ rightClick, shot, nap }) {
    await rightClick('.session');
    await nap(1200);
    await shot('session-menu');
  },

  async palette({ click, type, shot, nap }) {
    await click('.omnibar');
    await nap(600);
    await type('review');
    await nap(1200);
    await shot('palette');
  },
};

// ── driver ───────────────────────────────────────────────────────────────────

/** Pre-seed a profile so the very first paint is already on the requested theme. */
function seedProfile(theme) {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-shots-'));
  if (theme) {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { theme, restoreSessions: false } }),
    );
  }
  return dir;
}

async function runTheme(theme, sceneNames, repo) {
  const label = theme || 'default';
  const dest = join(outDir, label);
  mkdirSync(dest, { recursive: true });

  const { app, page, cleanup } = await launchApp({
    env: { CONDUIT_E2E: '1' },
    userDataDir: seedProfile(theme),
  });

  const shot = async (name) => {
    await page.screenshot({ path: join(dest, `${name}.png`) });
    console.log(`  ${label}/${name}.png`);
  };
  const click = (sel) =>
    page.evaluate((s) => {
      document.querySelector(s)?.click();
    }, sel);
  const clickText = (sel, t) =>
    page.evaluate(
      ({ s, t: text }) => {
        [...document.querySelectorAll(s)].find((e) => e.textContent.includes(text))?.click();
      },
      { s: sel, t },
    );
  const rightClick = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return;
      const b = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: b.left + Math.min(60, b.width / 2),
          clientY: b.top + Math.min(14, b.height / 2),
        }),
      );
    }, sel);
  const type = (t) => page.keyboard.type(t, { delay: 25 });
  const key = (k) => page.keyboard.press(k);
  const toTerminal = async () => {
    await click('.tab[data-tabid="__terminal__"]');
    await sleep(1200);
  };
  const open = async (query) => {
    await click('.omnibar');
    await sleep(600);
    await type(query);
    await sleep(1400);
    await key('Enter');
    await sleep(2500);
  };
  let sessionId = null;
  const term = async (data) => {
    await page.evaluate(
      ({ s, d }) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: d }),
      {
        s: sessionId,
        d: data,
      },
    );
  };

  try {
    await app.evaluate(
      (electron, s) => electron.BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h),
      { w: width, h: height },
    );
    await page.evaluate(() => {
      window.__sessions = [];
      window.agentDeck.subscribe((m) => {
        if (m.type === 'state') window.__sessions = m.sessions || [];
      });
      window.agentDeck.post({ type: 'ready' });
    });
    await sleep(1200);

    if (sceneNames.includes('empty')) {
      // Capture the empty state before anything is opened, then continue.
      await page.evaluate(() => {
        for (const s of window.__sessions || []) window.agentDeck.post({ type: 'kill', id: s.id });
      });
      await sleep(2000);
      await shot('empty');
    }

    const rest = sceneNames.filter((n) => n !== 'empty');
    if (rest.length) {
      await page.evaluate(
        (p) => window.agentDeck.post({ type: 'openRepo', path: p, agentId: 'shell:pwsh' }),
        repo,
      );
      await page.waitForSelector('.termpane', { state: 'attached', timeout: 25_000 });
      await sleep(4000);
      sessionId = await page.evaluate(() => (window.__sessions || []).slice(-1)[0]?.id);

      for (const name of rest) {
        const scene = SCENES[name];
        if (!scene) {
          console.log(`  ! unknown scene "${name}" — known: ${Object.keys(SCENES).join(', ')}`);
          continue;
        }
        try {
          await scene({
            page,
            app,
            shot,
            click,
            clickText,
            rightClick,
            type,
            key,
            toTerminal,
            open,
            term,
            nap: sleep,
            sleep,
            repo,
          });
        } catch (e) {
          console.log(`  ! scene "${name}" failed: ${e.message}`);
        }
      }
    }
  } finally {
    await closeApp(app, page).catch(() => {});
    await cleanup();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

if (process.platform !== 'win32') {
  console.log('[shoot] SKIP — Windows-only (the app ships Windows-only today)');
  process.exit(0);
}

const scenes = wanted.length ? wanted : ['empty', ...Object.keys(SCENES)];
const themes = themeArg === 'all' ? THEMES : themeArg ? [themeArg] : [''];

console.log(`[shoot] ${scenes.length} scene(s) × ${themes.length} theme(s) → ${outDir}`);
const repo = ensureFixtureRepo();
console.log(`[shoot] fixture: ${repo}`);
for (const t of themes) await runTheme(t, scenes, repo);
console.log('[shoot] done');
