/**
 * CON-73 — Settings fits the minimum window (900×560, electron/main.ts):
 *   1. No Settings page scrolls or overflows sideways. About carries a log line far wider than the
 *      pane: it must scroll inside its own block, not widen the page (the flex chain's min-width).
 *   2. In the MCP › Agents side panel and its editor, no two visible controls sit closer than the
 *      8px step of the spacing scale (dropdowns touching each other was the report).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario } from './harness.mjs';

const MIN_GAP = 8;
const userDataDir = fakeAgentProfile('settings-fit');
const { env } = isolatedHome(userDataDir);
const work = join(userDataDir, 'work');
mkdirSync(work);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { conduitMcp: true, logging: true } }),
);

/**
 * The page's width chain and its panes widening past their box, or any content ending past the
 * page's right edge. Inner scrollers (the log, code) may hold wide content, and a decoration may
 * overhang its own box (the theme swatch's check) as long as it stays on the page.
 */
const overflow = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.settings-page');
    if (!root) return ['no .settings-page'];
    const hits = [];
    const chain = root.querySelectorAll(
      '.settings__body, .settings__pane, .mcp-section, .mcp-section__panel, .permissions-roles > *, .permissions-drawer__body',
    );
    for (const el of [root, ...chain]) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      hits.push(
        `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''} ${el.scrollWidth}>${el.clientWidth}`,
      );
    }
    const right = root.getBoundingClientRect().right;
    for (const el of root.querySelectorAll('button, a, select, input, p, span, pre')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 1)
        hits.push(
          `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''} ends at ${Math.round(r.right)} > ${Math.round(right)}`,
        );
    }
    return hits;
  });

/** Pairs of visible controls in the side panel closer than `min` px. */
const tightControls = (page, min) =>
  page.evaluate((min) => {
    const body = document.querySelector('.permissions-drawer__body');
    if (!body) return ['no drawer body'];
    const hits = [];
    const controls = [
      ...body.querySelectorAll('select, button, input:not([type="checkbox"]):not([type="radio"])'),
    ]
      .filter((el) => el.getClientRects().length > 0)
      // Segmented controls are one control drawn as flush buttons.
      .filter((el) => !el.closest('.seg'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }));
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i].r;
        const b = controls[j].r;
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        let gap = null;
        if (across > 0) gap = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
        else if (down > 0) gap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
        if (gap !== null && gap < min) {
          const name = (el) => (el.textContent || el.value || el.tagName).trim().slice(0, 24);
          hits.push(`${name(controls[i].el)} ↔ ${name(controls[j].el)}: ${Math.round(gap)}px`);
        }
      }
    return hits;
  }, min);

await runScenario(
  'settings-fit',
  async ({ app, page, log }) => {
    await tapMcp(page);
    const session = await openFake(page, work);
    assert(
      await until(
        async () => (await mcpState(page))?.policy.sessions[session.sessionId] !== undefined,
        10_000,
      ),
      'session has no permission projection',
    );
    const wide = `settings-fit ${'/very/long/unbroken/path/segment'.repeat(12)}`;
    await page.evaluate((message) => window.agentDeck.post({ type: 'log', message }), wide);

    await app.evaluate((electron) =>
      electron.BrowserWindow.getAllWindows()[0].setContentSize(900, 560),
    );
    await page.waitForFunction(() => window.innerWidth === 900);

    await page.click('.footbtn[title^="Settings"]');
    const nav = page.locator('.settings__navitem');
    await nav.first().waitFor();
    const labels = (await nav.allTextContents()).map((t) => t.trim());
    assert(labels.includes('About'), `no About page in ${labels.join(', ')}`);
    for (const label of labels) {
      await nav.filter({ hasText: label }).first().click();
      if (label === 'About') {
        await page.locator('.settings__pane .about').waitFor();
        await page.locator('.settings__pane .about__logtail').waitFor();
        // The tail is read on mount and on Refresh; the logger may not have flushed by then.
        const refresh = page
          .locator('.about__logtailactions')
          .getByRole('button', { name: 'Refresh' });
        assert(
          await until(async () => {
            await refresh.click();
            return page
              .locator('.about__logtail')
              .evaluate((el, w) => el.textContent.includes(w), wide.slice(0, 40));
          }, 10_000),
          'the wide log line never reached the About log tail',
        );
      }
      const hits = await overflow(page);
      assert(hits.length === 0, `${label} overflows at 900px: ${hits.join('; ')}`);
      log(`${label}: fits`);
    }

    await nav.filter({ hasText: 'MCP' }).first().click();
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await page.locator('.permissions-agents-list__title').first().click();
    const drawer = page.locator('aside.permissions-drawer');
    await drawer.waitFor();
    await drawer.getByRole('heading', { name: 'Check a request' }).waitFor();
    let tight = await tightControls(page, MIN_GAP);
    assert(tight.length === 0, `agent drawer controls touch: ${tight.join('; ')}`);
    let hits = await overflow(page);
    assert(hits.length === 0, `the agent drawer overflows at 900px: ${hits.join('; ')}`);

    await drawer.getByText('Advanced settings', { exact: true }).click();
    await drawer.getByRole('button', { name: 'Edit assignment', exact: true }).click();
    await drawer.getByRole('heading', { name: /^Edit assignment/ }).waitFor();
    tight = await tightControls(page, MIN_GAP);
    assert(tight.length === 0, `assignment editor controls touch: ${tight.join('; ')}`);

    // The role editor's launch-mode pairs (Claude / Codex selects) share the same rhythm.
    await page.getByRole('tab', { name: 'Roles', exact: true }).click();
    await page.locator('.permissions-role-list__name', { hasText: 'Worker' }).click();
    await drawer.getByRole('button', { name: 'Duplicate role' }).click();
    await drawer.getByText('Agent’s own mode at launch').waitFor();
    tight = await tightControls(page, MIN_GAP);
    assert(tight.length === 0, `role editor controls touch: ${tight.join('; ')}`);
    hits = await overflow(page);
    assert(hits.length === 0, `the role editor overflows at 900px: ${hits.join('; ')}`);
    log('side panel keeps the spacing step');
  },
  { env, userDataDir },
);
