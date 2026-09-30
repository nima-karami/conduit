/**
 * New session dialog, launchers (mf-new-session spec §7): pills ranked by use, More, custom
 * launchers, and launchers.json keeping both across a quit. Starts from the history
 * new-session-folders-start builds (replayed).
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, phase } from './harness.mjs';
import {
  closeDialog,
  launchTapped,
  openDialog,
  openRepoViaHost,
  pills,
  replayProjectSession,
  runNewSession,
  stateAgents,
} from './new-session-folders-helpers.mjs';

await runNewSession('new-session-folders-launchers', async ({ fx, log, launch, close }) => {
  const { B, userDataDir } = fx;
  const { app, page } = await launchTapped(launch);

  phase('replay project session');
  await replayProjectSession(app, page, fx);

  phase('ranking and More');
  for (const agentId of ['cli:codex', 'cli:codex', 'cli:codex', 'cli:claude']) {
    const r = await openRepoViaHost(page, B, agentId);
    assert(r.sessionId, `openRepo ${agentId} should create a session (${JSON.stringify(r)})`);
  }
  const launchersFile = join(userDataDir, 'launchers.json');
  await openDialog(page);
  const ranked = await pills(page);
  assert(
    JSON.stringify(ranked.slice(0, 2)) === JSON.stringify(['codex', 'claude']) &&
      ranked.includes('Shell'),
    `after 3 codex and 2 claude starts the row leads codex, claude, then Shell (got ${ranked})`,
  );
  log('ranking: codex, claude, …, Shell ✓ (AC2)');
  await page.locator('.ns-more').click();
  await page.waitForSelector('.ns-more-menu', { state: 'visible' });
  const more = await page.evaluate(() => {
    const m = document.querySelector('.ns-more-menu')?.getBoundingClientRect();
    const b = document.querySelector('.ns-more')?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.ns-more__item')].map((r) => [
      r.querySelector('.ns-more__label')?.textContent,
      r.querySelector('.ns-more__tag')?.textContent,
    ]);
    const items = [...document.querySelectorAll('.ns-more-menu [role^="menuitem"]')];
    return {
      dx: Math.abs((m?.right ?? 0) - (b?.right ?? 1e9)),
      head: document.querySelector('.ns-more__head')?.textContent,
      rows,
      last: items.at(-1)?.textContent,
    };
  });
  assert(more.head === 'Found on this machine', `More's header (got ${more.head})`);
  assert(more.dx <= 1, `More's right edge within 1px of the button's (off by ${more.dx}px)`);
  assert(
    more.rows.length > 0 &&
      more.rows.every(([l, t]) => l && ['PATH', 'shell', 'config', 'custom'].includes(t)),
    `every More row is labelled and tagged (got ${JSON.stringify(more.rows)})`,
  );
  assert(more.last === '+ Custom command…', `More ends with + Custom command… (got ${more.last})`);
  await page.locator('.ns-more').click();
  await page.waitForSelector('.ns-more-menu', { state: 'detached', timeout: 3000 });
  log('More: header, tags, custom row, right-aligned, second click closes ✓ (AC3)');
  await closeDialog(page);

  phase('custom command');
  await openDialog(page);
  await page.locator('.ns-more').click();
  await page.locator('.ns-more__custom').click();
  await page.locator('input[aria-label="Command"]').fill('codex --x');
  await page.locator('.ns-custom .btn--primary', { hasText: 'Add' }).click();
  await page.waitForSelector('.ns-custom', { state: 'detached', timeout: 8000 });
  const selected = await page.locator('.ns-pill[aria-checked="true"]').innerText();
  assert(selected === 'codex (2)', `the new launcher is the selected extra pill (got ${selected})`);
  const withCustom = await stateAgents(page);
  assert(
    withCustom.some((id) => id.startsWith('custom:')),
    `state.agents gains the custom launcher (got ${withCustom})`,
  );
  await closeDialog(page);
  log('custom command: codex (2) selected ✓');

  phase('launchers.json after quit');
  await close();
  const launchers = JSON.parse(readFileSync(launchersFile, 'utf8'));
  const custom = launchers.custom.find((d) => d.id.startsWith('custom:'));
  assert(
    custom?.label === 'codex (2)' && JSON.stringify(custom.args) === JSON.stringify(['--x']),
    `launchers.json keeps the custom launcher (got ${JSON.stringify(launchers.custom)})`,
  );
  assert(
    launchers.usage['cli:codex']?.count === 3 && launchers.usage['cli:claude']?.count >= 2,
    `launchers.json keeps the use counts (got ${JSON.stringify(launchers.usage)})`,
  );
  log('launchers.json: custom launcher + usage persisted ✓');
});
