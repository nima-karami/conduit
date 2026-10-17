/**
 * Right-click on a terminal path link (plan docs/plans/2026-10-16-terminal-path-links.plan.md
 * T5.3; spec §3.4, rows 57–58). A non-git parent holds repoB (git) with src/a.ts; the session at
 * the parent belongs to project LinkProj. Every hover and right-click is a real mouse event at
 * the link's cells.
 *
 *   - A dir link's menu: Copy path, Copy relative path, Reveal in Explorer, Open as new session
 *     ("in LinkProj"), then the terminal's Copy, Paste, Find, Clear.
 *   - Open as new session prefills the New session dialog with the folder and the project; Esc
 *     returns focus to the terminal.
 *   - A file link's menu starts with Open; Open as new session prefills the file's repo root.
 *   - Plain text and a URL keep today's four-item terminal menu.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  createProject,
  openSession,
  runScenario,
  typeLine,
  waitForOutput,
} from './harness.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// The dialog bookends paths with LRMs and either separator/case may come back.
const norm = (p) =>
  (p ?? '')
    .replace(/[\u200e\s]/g, '')
    .replace(/\\/g, '/')
    .toLowerCase();

const TERMINAL_ITEMS = ['Copy', 'Paste', 'Find', 'Clear'];

runScenario('terminal-link-menu', async ({ page, log }) => {
  const parent = mkdtempSync(join(tmpdir(), 'conduit-plm-')).replace(/\\/g, '/');
  const repoB = `${parent}/repoB`;
  mkdirSync(join(repoB, 'src'), { recursive: true });
  git(['init', '-q', '-b', 'main'], repoB);
  git(['config', 'user.email', 't@t'], repoB);
  git(['config', 'user.name', 't'], repoB);
  git(['config', 'commit.gpgsign', 'false'], repoB);
  writeFileSync(join(repoB, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '-A'], repoB);
  git(['commit', '-qm', 'a'], repoB);
  log('fixture', parent);

  const projectId = await createProject(page, 'LinkProj');
  await page.evaluate(() => {
    window.__terms = {};
  });
  const sid = await openSession(page, { path: parent, projectId });
  await page.waitForFunction(
    (id) => (window.__sessions || []).find((x) => x.id === id)?.repos?.length === 1,
    sid,
    { timeout: 30000 },
  );
  await page.waitForFunction(() => (window.__cap || '').includes('>'), null, { timeout: 30000 });

  const DIR_LINE = repoB;
  const FILE_LINE = 'repoB/src/a.ts';
  const PLAIN_LINE = 'just some words';
  const URL_LINE = 'https://example.com/plm';
  // Printed by the shell, so ConPTY's repaints keep them (see terminal-path-links-v2).
  for (const line of [DIR_LINE, FILE_LINE, PLAIN_LINE, URL_LINE]) {
    await typeLine(page, sid, `echo ${line}`);
    await waitForOutput(page, sid, line);
  }
  await page.waitForTimeout(800);

  /** Viewport point of char `charIdx` of the last row that is exactly `line` (the echo output). */
  const cellOf = (line, charIdx) =>
    page.evaluate(
      ({ id, line, charIdx }) => {
        const term = window.__terms[id];
        const buf = term.buffer.active;
        let row = -1;
        for (let y = 0; y < buf.length; y++) {
          if ((buf.getLine(y)?.translateToString(true) ?? '').trim() === line) row = y;
        }
        const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
        const screenRow = row - buf.viewportY;
        return {
          ok: row >= 0 && screenRow >= 0 && screenRow < term.rows && r.width > 0,
          x: r.x + (charIdx + 0.5) * (r.width / term.cols),
          y: r.y + (screenRow + 0.5) * (r.height / term.rows),
        };
      },
      { id: sid, line, charIdx },
    );

  /** Real hover (waiting for the link pointer when `onLink`), then a real right-click. */
  const rightClick = async (line, charIdx, { onLink = true } = {}) => {
    const c = await cellOf(line, charIdx);
    assert(c.ok, `"${line}" is not on screen`);
    const pointer = () =>
      page.evaluate(
        (id) => !!window.__terms[id].element.querySelector('.xterm-cursor-pointer'),
        sid,
      );
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(c.x, c.y + 300);
      await page.mouse.move(c.x, c.y, { steps: 4 });
      await page.waitForTimeout(400);
      if (!onLink || (await pointer())) break;
    }
    if (onLink) assert(await pointer(), `"${line}" never showed the link pointer`);
    await page.mouse.click(c.x, c.y, { button: 'right' });
    await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
    return page.evaluate(() =>
      Array.from(document.querySelectorAll('.ctxmenu .ctxmenu__item')).map((el) => ({
        label: el.querySelector('.ctxmenu__label')?.textContent?.trim() ?? el.textContent?.trim(),
        hint: el.querySelector('.ctxmenu__hint')?.textContent?.trim() ?? null,
      })),
    );
  };

  const choose = (label) =>
    page.locator('.ctxmenu .ctxmenu__item').filter({ hasText: label }).first().click();

  const dialogHome = async () => {
    await page.waitForSelector('.modal.ns', { state: 'visible', timeout: 8000 });
    return page.locator('.ns-folder--home .ns-folder__path').first().innerText();
  };

  const escapeToTerminal = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 5000 });
    const cls = await page.evaluate(() => document.activeElement?.className ?? '');
    assert(
      cls.includes('xterm-helper-textarea'),
      `focus should return to the terminal, got "${cls}"`,
    );
  };

  // ── dir link ──────────────────────────────────────────────────────────────────────
  const dirMenu = await rightClick(DIR_LINE, Math.floor(DIR_LINE.length / 2));
  log('dir menu:', JSON.stringify(dirMenu));
  const want = [
    'Copy path',
    'Copy relative path',
    'Reveal in Explorer',
    'Open as new session',
    ...TERMINAL_ITEMS,
  ];
  assert(
    JSON.stringify(dirMenu.map((i) => i.label)) === JSON.stringify(want),
    `dir link menu should be ${JSON.stringify(want)}, got ${JSON.stringify(dirMenu)}`,
  );
  const oas = dirMenu.find((i) => i.label === 'Open as new session');
  assert(
    oas?.hint === 'in LinkProj',
    `Open as new session should hint "in LinkProj", got ${oas?.hint}`,
  );
  log('dir link menu: link actions, then the terminal menu ✓');

  await choose('Open as new session');
  const dirHome = await dialogHome();
  assert(norm(dirHome) === norm(repoB), `New session home should be ${repoB}, got ${dirHome}`);
  const projChip = await page.locator('.ns-chip__body[aria-label="Project: LinkProj"]').count();
  assert(projChip === 1, 'the New session dialog should be prefilled with project LinkProj');
  await escapeToTerminal();
  log('dir → Open as new session prefills folder + project; Esc returns focus ✓');

  // ── file link ─────────────────────────────────────────────────────────────────────
  const fileMenu = await rightClick(FILE_LINE, 7);
  log('file menu:', JSON.stringify(fileMenu.map((i) => i.label)));
  assert(
    fileMenu[0]?.label === 'Open',
    `a file link's menu should start with Open, got ${fileMenu[0]?.label}`,
  );
  await choose('Open as new session');
  const fileHome = await dialogHome();
  assert(
    norm(fileHome) === norm(repoB),
    `a file opens its repo root ${repoB} as the home, got ${fileHome}`,
  );
  await escapeToTerminal();
  log('file → Open first; Open as new session prefills the repo root ✓');

  // ── plain text and a URL keep today's menu ────────────────────────────────────────
  for (const [line, onLink] of [
    [PLAIN_LINE, false],
    [URL_LINE, true],
  ]) {
    const menu = await rightClick(line, 3, { onLink });
    assert(
      JSON.stringify(menu.map((i) => i.label)) === JSON.stringify(TERMINAL_ITEMS),
      `"${line}" should keep the terminal menu, got ${JSON.stringify(menu)}`,
    );
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  }
  log('plain text and URL keep the four-item terminal menu ✓');
});
