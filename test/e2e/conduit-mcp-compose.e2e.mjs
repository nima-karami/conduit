/**
 * conduit-mcp-compose — the human side of messaging, driven by real clicks (spec
 * docs/specs/2026-10-25-conduit-mcp-server.md §8–§9; plan T10.7):
 *   1. Messages tab → New message → fake-1 → Send: the thread appears and fake-1 is noticed.
 *   2. fake-1 sends to `you` with an attachment: the chip names the reason, the tab badge shows 1,
 *      opening the thread clears it, and Open attachment shows the snapshotted text.
 *   3. Card menu → Pause notices: a send to the paused fake gives no notice for 8 s, and its card
 *      shows the pause glyph. Resume delivers it.
 *   4. fake-2 shows `permit`: its card's tooltip names the held gate.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  notices,
  openFake,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, runScenario, typeLine } from './harness.mjs';

// Once a fake goes quiet the gate wants its busy window (1.5 s) + 3 s quiet + a 0.5 s tick, then
// text + gap + Enter; the slack covers polling and a loaded runner (see conduit-mcp-gate).
const NOTICE_WITHIN_MS = 15_000;
const ATTACHMENT_TEXT = 'compose check: the attachment the human opens\n';

await runScenario(
  'conduit-mcp-compose',
  async ({ page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'conduit-mcp-compose-'));
    writeFileSync(join(work, 'note.txt'), ATTACHMENT_TEXT);
    const a = await openFake(page, work);
    const b = await openFake(page, work);
    log(`A=${a.handle} B=${b.handle}`);
    await sleep(4_000);

    const messagesTab = page.locator('.rightpane .rtab', { hasText: 'Messages' });
    const tabBadge = messagesTab.locator('.rtab__badge');
    const card = (s) => page.locator(`.session[data-sessionid="${s.sessionId}"]`);
    const cardMenu = async (s, label) => {
      await card(s).click({ button: 'right' });
      await page.locator('.ctxmenu__item', { hasText: label }).click();
    };

    // 1. compose as you
    await messagesTab.click();
    await page.locator('.mcpmsg__bar button', { hasText: 'New message' }).click();
    await page.locator('.mcpmsg-compose__recipient', { hasText: a.handle }).click();
    await page.locator('.mcpmsg-compose__body').click();
    await page.keyboard.type('compose check from the human');
    await page.locator('.mcpmsg-compose button', { hasText: 'Send' }).click();
    await page.locator('.mcpmsg [role="option"]').first().waitFor({ timeout: 10_000 });
    const noticedA = await until(() => notices(a.sessionId).length > 0, NOTICE_WITHIN_MS);
    assert(noticedA, `${a.handle} was never noticed of the human's message`);

    // 2. a message for you, with an attachment
    const sent = await callTool(page, a.sessionId, 'send_message', {
      to: ['you'],
      subject: 'attachment for you',
      body: 'see the note',
      attachments: [{ path: 'note.txt' }],
    });
    assert(sent.recipients?.[0]?.status === 'queued', `send to you: ${JSON.stringify(sent)}`);
    const chipSaid = await until(
      async () =>
        (
          (await page
            .locator('.attnchip')
            .textContent()
            .catch(() => '')) ?? ''
        ).includes('a message for you'),
      10_000,
    );
    assert(
      chipSaid,
      `chip text: ${await page
        .locator('.attnchip')
        .textContent()
        .catch(() => '')}`,
    );
    await tabBadge.waitFor({ timeout: 5_000 });
    const badgeText = (await tabBadge.textContent())?.trim() ?? '';
    assert(badgeText.startsWith('1'), `tab badge: ${badgeText}`);
    await page.locator('.mcpmsg [role="option"]', { hasText: 'attachment for you' }).click();
    await tabBadge.waitFor({ state: 'detached', timeout: 5_000 });
    await page.locator('button[aria-label="Open attachment: note.txt"]').click();
    const pre = page.locator('[role="dialog"] .mcpmsg-attview__text');
    await pre.waitFor({ timeout: 5_000 });
    const shown = await pre.textContent();
    assert(shown === ATTACHMENT_TEXT, `attachment view: ${JSON.stringify(shown)}`);
    await page.locator('[role="dialog"] button', { hasText: 'Close' }).click();

    // 3. pause notices from the card menu
    await cardMenu(b, `Pause notices for ${b.handle}`);
    await card(b).locator('.session__mcp-paused').waitFor({ timeout: 5_000 });
    const toPaused = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      body: 'while paused',
    });
    assert(toPaused.recipients?.[0]?.status === 'queued', `send: ${JSON.stringify(toPaused)}`);
    await sleep(8_000);
    assert(notices(b.sessionId).length === 0, 'a paused session was noticed');
    await cardMenu(b, `Resume notices for ${b.handle}`);
    await card(b).locator('.session__mcp-paused').waitFor({ state: 'detached', timeout: 5_000 });
    const noticedB = await until(() => notices(b.sessionId).length > 0, NOTICE_WITHIN_MS);
    assert(noticedB, `${b.handle} was not noticed after Resume`);

    // 4. the held gate's reason on the card
    await typeLine(page, b.sessionId, 'permit');
    const held = await until(
      async () => (await card(b).getAttribute('title')) === 'Notices held: prompt on screen',
      10_000,
    );
    assert(held, `card tooltip: ${await card(b).getAttribute('title')}`);
  },
  { userDataDir: fakeAgentProfile('conduit-mcp-compose') },
);
