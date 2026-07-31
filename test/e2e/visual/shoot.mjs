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
