/**
 * role-brief — a session created with a typed role brief launches its CLI with the one-turn
 * prompt exactly once (docs/specs/2026-10-26-conduit-role-brief.md §7; plan T6.2):
 *   New session dialog → Role brief → Text → Start; the fake agent's ARGV record ends
 *   `-- Read your role brief at <file> and follow it.` and the file holds the typed text.
 *   Then `quit` (the fake exits), Relaunch, and the second ARGV record has no prompt.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ID, fakeAgentProfile, records, until } from './conduit-mcp-helpers.mjs';
import { assert, runScenario, tapBridge, typeLine } from './harness.mjs';
import { browseAdd, openDialog, tapResults } from './new-session-folders-helpers.mjs';

const BRIEF = 'You manage the fake team';
const PROMPT_RE = /^Read your role brief at (.+) and follow it\.$/;

const userDataDir = fakeAgentProfile('role-brief');

await runScenario(
  'role-brief',
  async ({ app, page, log }) => {
    await tapBridge(page);
    await tapResults(page);
    const work = mkdtempSync(join(tmpdir(), 'role-brief-'));

    await openDialog(page);
    // Ranking depends on the machine: with fewer than three CLIs installed (the runner) the fake
    // fills a pill slot, otherwise it is only in More.
    const pill = page.locator(`.ns-launch [data-launcher="${FAKE_AGENT_ID}"]`);
    await page.locator('.ns-more').waitFor();
    if ((await pill.count()) > 0) await pill.click();
    else {
      await page.locator('.ns-more').click();
      await page.locator('.ns-more__item', { hasText: 'Fake MCP' }).click();
    }
    await browseAdd(app, page, [work]);
    await page.locator('.ns-brief [role="radio"]', { hasText: /^Text$/ }).click();
    await page.locator('[aria-label="Role brief text"]').fill(BRIEF);
    await page.locator('.ns__foot .btn--primary').click();
    await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10_000 });
    const sid = await page.evaluate(
      () => window.__results.find((m) => m.type === 'openRepo:result')?.sessionId,
    );
    assert(sid, 'openRepo:result carries the new sessionId');

    assert(
      await until(() => records(sid, 'ARGV').length > 0, 30_000),
      'the fake agent never recorded its argv',
    );
    const argv = records(sid, 'ARGV')[0].argv;
    assert(
      argv.at(-2) === '--',
      `argv ends with "--" then the prompt (got ${JSON.stringify(argv)})`,
    );
    const match = PROMPT_RE.exec(argv.at(-1));
    assert(match, `the last arg is the role brief prompt (got ${JSON.stringify(argv.at(-1))})`);
    const body = readFileSync(match[1], 'utf8');
    assert(
      body.includes(BRIEF),
      `the brief file holds the typed text (got ${JSON.stringify(body)})`,
    );
    log('first launch: prompt is the last argv entry and the file holds the brief ✓');

    await typeLine(page, sid, 'quit');
    assert(
      await until(
        () =>
          page.evaluate(
            (id) => (window.__sessions || []).find((s) => s.id === id)?.status === 'exited',
            sid,
          ),
        20_000,
      ),
      'the session never read exited after quit',
    );
    await page.evaluate((id) => window.agentDeck.post({ type: 'relaunch', id }), sid);
    assert(
      await until(() => records(sid, 'ARGV').length >= 2, 30_000),
      'the relaunched fake agent never recorded a second argv',
    );
    const again = records(sid, 'ARGV')[1].argv;
    assert(
      !again.some((a) => a.includes('Read your role brief')),
      `a relaunch must not re-send the brief (got ${JSON.stringify(again)})`,
    );
    log('relaunch: no prompt re-sent ✓');
  },
  { userDataDir },
);
