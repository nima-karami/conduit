/**
 * requests-ui: the Needs you panel, the request pop-up and tab, the session pill and Away, driven in
 * the real app (plan docs/plans/2026-11-14-request-queue-ui.plan.md U2–U5; design CON-10 iter-7).
 *   (a) a fake agent asks a choose and waits: the panel lists one card, the status bar counts it
 *       with a countdown, and the asking session's tab bar shows the pill.
 *   (b) Enter on the card opens the pop-up with its title focused; picking 1 and Send answers it,
 *       and the agent's waiting call returns the pick.
 *   (c) a review request opens as a tab beside the session; Approve as written + Send ends it.
 *   (d) Away from the status bar shows the banner; I'm back ends it and the digest appears.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  mcpState,
  openFake,
  resultAfter,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, runScenario, showRightView } from './harness.mjs';

const OPTIONS = [{ label: 'Blue/green' }, { label: 'In place' }];
/** Set CONDUIT_SHOTS_DIR to keep screenshots of each state for comparison with the design PNGs. */
const SHOTS = process.env.CONDUIT_SHOTS_DIR;
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

await runScenario(
  'requests-ui',
  async ({ page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'requests-ui-'));
    const a = await openFake(page, work);

    phase('panel, status bar and pill');
    const before = await startCall(page, a.sessionId, 'request_input', {
      kind: 'choose',
      title: 'Which deploy?',
      options: OPTIONS,
      wait_s: 90,
    });
    await showRightView(page, 'needs');
    const card = page.locator('.needs-list [role="option"]', { hasText: 'Which deploy?' });
    await card.waitFor({ timeout: 15_000 });
    const attn = page.locator('[data-status-item="attention"]');
    await attn.waitFor({ timeout: 10_000 });
    assert(/waiting/.test((await attn.textContent()) ?? ''), 'the status bar shows no countdown');
    await page.locator('.needs-pill').first().waitFor({ timeout: 10_000 });
    await shot(page, 'needs-list');
    log('card, status-bar countdown and session pill ✓');

    phase('pop-up from the list');
    await page.locator('.needs-list').focus();
    await page.keyboard.press('Enter');
    const popup = page.locator('.reqtpl-popup');
    await popup.waitFor({ timeout: 10_000 });
    assert(
      await page.evaluate(
        () => document.activeElement?.classList.contains('reqtpl-head__title') ?? false,
      ),
      'the pop-up did not focus its title',
    );
    await shot(page, 'reqtpl-popup');
    await popup.locator('input[data-key]').first().check();
    await popup.locator('.reqtpl-send').click();
    const answered = await resultAfter(a.sessionId, before, 15_000);
    assert(
      answered?.state === 'answered' && answered.answer?.values?.[0] === 'Blue/green',
      `the agent did not get the pick: ${JSON.stringify(answered)}`,
    );
    log('Enter opens the pop-up, Send answers the waiting call ✓');

    phase('review opens as a tab');
    const review = await callTool(page, a.sessionId, 'request_input', {
      kind: 'review',
      title: 'Changelog entry',
      draft: '## 0.65.0\n\n- Needs you panel',
      wait_s: 0,
    });
    assert(review?.state === 'open', `review not open: ${JSON.stringify(review)}`);
    const reviewCard = page.locator('.needs-list [role="option"]', { hasText: 'Changelog entry' });
    await reviewCard.waitFor({ timeout: 15_000 });
    await reviewCard.click();
    const tab = page.locator('.reqtpl-tab');
    await tab.waitFor({ timeout: 10_000 });
    await shot(page, 'reqtpl-review-tab');
    await tab.locator('.reqtpl-option', { hasText: 'Approve as written' }).click();
    await tab.locator('.reqtpl-send').click();
    assert(
      await until(async () => {
        const st = await mcpState(page);
        return st?.requests?.ended.some(
          (r) => r.id === review.request_id && r.state === 'answered',
        );
      }, 10_000),
      'the review was not answered from its tab',
    );
    log('review tab answers ✓');

    phase('Away and the digest');
    await page.locator('[data-status-item="away"]').click();
    await page.locator('[role="menuitem"]', { hasText: "Until I'm back" }).click();
    await page.locator('.needs-away__banner').waitFor({ timeout: 10_000 });
    await shot(page, 'needs-away');
    await page.locator('.needs-away__back').click();
    await page.locator('.needs-digest').waitFor({ timeout: 10_000 });
    await shot(page, 'needs-digest');
    log('Away banner, then the return digest ✓');
  },
  { userDataDir: fakeAgentProfile('requests-ui') },
);
