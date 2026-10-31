/**
 * conduit-mcp-app-sessions — close_session, focus_session and attach_folder end to end (spec
 * docs/specs/2026-10-30-conduit-mcp-app-control.md §2.1, §2.3, §3; plan T3.2). Fake agents A, B, C
 * in window 1 and E, F in window 2, so the real shim, gate, call flow, mcp:ui round trip and
 * approval card are in the path:
 *   - an off-screen caller is refused caller_not_visible and nothing moves;
 *   - focus_session switches the human's view; move:no refuses move_not_allowed and stays;
 *   - reach self / opened / window / any each refuse out_of_reach outside their set, and nothing
 *     happens to the target; a session A opened is closable under opened;
 *   - an unknown target is unknown_session;
 *   - attach_folder asks by default, attaches on approve, is idempotent, and refuses another
 *     session under its default reach self without asking;
 *   - close_session refuses unsaved_changes naming the dirty file and closes nothing, then closes
 *     once clean;
 *   - a target in another window: focus raises it there (reach any), close runs its dirty check
 *     in that window;
 *   - a caller closing itself still gets its reply.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDirty, tab, typeAtStart } from './auto-save-helpers.mjs';
import { namesFile } from './conduit-mcp-app-helpers.mjs';
import {
  activeSessionId,
  callTool,
  clickAskAnswer,
  FAKE_AGENT_ID,
  fakeAgentProfile,
  handleOf,
  openFake,
  resultAfter,
  sessions,
  setSessionPolicy,
  sleep,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';

const errCode = (r) => r?.error?.code;
const errMessage = (r) => r?.error?.message ?? '';

/** A second window over `win:new`, as dirty-quit-windows opens one. */
async function newWindow(app, page) {
  const before = await app.evaluate((e) => e.BrowserWindow.getAllWindows().map((w) => w.id));
  const next = app.waitForEvent('window', { timeout: 20_000 });
  await page.evaluate(() => window.agentDeck.post({ type: 'win:new' }));
  const page2 = await next;
  await page2.waitForLoadState('domcontentloaded');
  await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20_000 });
  const id = await app.evaluate(
    (e, ids) =>
      e.BrowserWindow.getAllWindows()
        .map((w) => w.id)
        .find((x) => !ids.includes(x)),
    before,
  );
  return { page: page2, id };
}

await runScenario(
  'conduit-mcp-app-sessions',
  async ({ app, page, log }) => {
    await tapMcp(page);
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-mcp-app-sessions-${label}-`));
    const dirA = temp('a');
    const dirB = temp('b');
    const dirC = temp('c');
    const dirD = temp('d');
    const dirE = temp('e');
    const dirF = temp('f');
    const extra = temp('extra');
    mkdirSync(join(dirA, 'sub'));
    writeFileSync(join(dirC, 'fixture.txt'), 'close fixture\n');

    const isActive = async (p, sessionId) => (await activeSessionId(p)) === sessionId;
    const makeActive = async (sessionId) => {
      await page.locator(`.session[data-sessionid="${sessionId}"]`).click();
      assert(
        await until(() => isActive(page, sessionId), 5_000),
        `${sessionId} never became active`,
      );
    };
    const exists = async (p, sessionId) => (await sessions(p)).some((s) => s.id === sessionId);
    const rootsOf = async (p, sessionId) =>
      (await sessions(p)).find((s) => s.id === sessionId)?.roots ?? null;
    const card = page.locator('.askcard');

    phase('setup');
    const a = await openFake(page, dirA);
    const b = await openFake(page, dirB);
    const c = await openFake(page, dirC);
    await makeActive(a.sessionId);

    phase('caller_not_visible');
    const hidden = await callTool(page, b.sessionId, 'focus_session', { session: c.handle });
    assert(errCode(hidden) === 'caller_not_visible', `off-screen B: ${JSON.stringify(hidden)}`);
    await sleep(1_000);
    assert(await isActive(page, a.sessionId), 'a refused focus_session moved the view');
    log('off-screen caller refused caller_not_visible, view unchanged ✓');

    phase('focus');
    const focused = await callTool(page, a.sessionId, 'focus_session', { session: b.handle });
    assert(focused?.focused === b.sessionId, `focus_session: ${JSON.stringify(focused)}`);
    assert(await until(() => isActive(page, b.sessionId), 5_000), 'B never became active');
    log('focus_session switches the view to B ✓');

    phase('move:no');
    await makeActive(a.sessionId);
    await setSessionPolicy(page, a.sessionId, 'focus_session', { move: 'no' });
    const stay = await callTool(page, a.sessionId, 'focus_session', { session: c.handle });
    assert(errCode(stay) === 'move_not_allowed', `move:no: ${JSON.stringify(stay)}`);
    // A switch lands within a frame of the activateSession message; give it well over that.
    await sleep(1_000);
    assert(await isActive(page, a.sessionId), 'move:no still moved the view');
    await setSessionPolicy(page, a.sessionId, 'focus_session', { move: 'inherit' });
    log('move:no refuses move_not_allowed and A stays on screen ✓');

    phase('reach');
    await setSessionPolicy(page, a.sessionId, 'close_session', { access: 'on', reach: 'self' });
    const self = await callTool(page, a.sessionId, 'close_session', { session: b.handle });
    assert(errCode(self) === 'out_of_reach', `reach self: ${JSON.stringify(self)}`);
    assert(!errMessage(self).includes(b.handle), `the refusal names B: ${errMessage(self)}`);
    await sleep(1_000);
    assert(await exists(page, b.sessionId), 'a reach-refused close still closed B');
    await setSessionPolicy(page, a.sessionId, 'close_session', { reach: 'opened' });
    await setSessionPolicy(page, a.sessionId, 'open_session', { access: 'on' });
    const opened = await callTool(page, a.sessionId, 'open_session', {
      path: dirD,
      agent: FAKE_AGENT_ID,
      focus: false,
    });
    assert(opened?.session_id, `open_session: ${JSON.stringify(opened)}`);
    // A background session's PTY starts only once shown, so D never connects; it is listed (and
    // targetable) from its handle on.
    const d = { sessionId: opened.session_id, handle: await handleOf(page, opened.session_id) };
    const notOpened = await callTool(page, a.sessionId, 'close_session', { session: c.handle });
    assert(errCode(notOpened) === 'out_of_reach', `reach opened, C: ${JSON.stringify(notOpened)}`);
    await sleep(1_000);
    assert(await exists(page, c.sessionId), 'a reach-refused close still closed C');
    const closedD = await callTool(page, a.sessionId, 'close_session', { session: d.handle });
    assert(closedD?.closed === d.sessionId, `reach opened, D: ${JSON.stringify(closedD)}`);
    assert(
      await until(async () => !(await exists(page, d.sessionId)), 5_000),
      'D survived its close',
    );
    assert(await isActive(page, a.sessionId), 'closing D moved the view');
    log('reach self / opened refuse out_of_reach and keep the target; opened closes D ✓');

    phase('unknown');
    const unknown = await callTool(page, a.sessionId, 'close_session', { session: 'nope-9' });
    assert(errCode(unknown) === 'unknown_session', `unknown: ${JSON.stringify(unknown)}`);
    log('unknown target → unknown_session ✓');

    phase('attach reach self');
    // attach_folder's defaults: ask, reach self. A reach refusal comes before the ask.
    const bRoots = await rootsOf(page, b.sessionId);
    const before = await startCall(page, a.sessionId, 'attach_folder', {
      path: extra,
      session: b.handle,
    });
    const notMine = await resultAfter(a.sessionId, before, 10_000);
    assert(errCode(notMine) === 'out_of_reach', `attach to B: ${JSON.stringify(notMine)}`);
    assert((await card.count()) === 0, 'a reach-refused attach still asked');
    assert(
      JSON.stringify(await rootsOf(page, b.sessionId)) === JSON.stringify(bRoots),
      `B's roots changed: ${JSON.stringify(await rootsOf(page, b.sessionId))}`,
    );
    log('attach_folder for another session refused out_of_reach without asking ✓');

    phase('attach (ask)');
    /** Ask, check the card names the caller, tool and `want`, approve, and resolve the result. */
    const attachApproved = async (path, want) => {
      const n = await startCall(page, a.sessionId, 'attach_folder', { path });
      await card.waitFor({ timeout: 10_000 });
      const text = (await card.textContent()) ?? '';
      assert(
        text.includes(`${a.handle} requests attach_folder`) && text.includes(want),
        `card text: ${JSON.stringify(text)}`,
      );
      await clickAskAnswer(page, 'approve');
      const r = await resultAfter(a.sessionId, n, 15_000);
      await card.waitFor({ state: 'detached', timeout: 5_000 });
      return r;
    };
    // A folder inside the home overlaps it: addRoot's refusal comes back as attach_refused.
    const nested = await attachApproved('sub', 'sub');
    assert(
      errCode(nested) === 'attach_refused' && errMessage(nested).includes('overlaps'),
      `nested attach: ${JSON.stringify(nested)}`,
    );
    assert((await rootsOf(page, a.sessionId))?.length === 0, 'a refused attach added a root');
    const extraName = extra.split(/[\\/]/).pop();
    const attached = await attachApproved(extra, extraName);
    assert(
      attached?.session_id === a.sessionId && namesFile(attached.attached, extra),
      `attach: ${JSON.stringify(attached)}`,
    );
    assert(
      attached.roots.length === 1 && namesFile(attached.roots[0], extra),
      `attach roots: ${JSON.stringify(attached.roots)}`,
    );
    assert(
      await until(async () => (await rootsOf(page, a.sessionId))?.length === 1, 5_000),
      `A's roots: ${JSON.stringify(await rootsOf(page, a.sessionId))}`,
    );
    const again = await attachApproved(extra, extraName);
    assert(again?.roots?.length === 1, `repeat attach: ${JSON.stringify(again)}`);
    assert((await rootsOf(page, a.sessionId))?.length === 1, 'a repeat attach added a root');
    log('attach_folder asks; a nested folder is attach_refused; extra attaches once ✓');

    phase('close dirty');
    await setSessionPolicy(page, a.sessionId, 'close_session', { reach: 'inherit' });
    await makeActive(c.sessionId);
    const f = await callTool(page, c.sessionId, 'open_file', { path: 'fixture.txt' });
    assert(f?.opened, `C's open_file: ${JSON.stringify(f)}`);
    await tab(page, 'fixture.txt').waitFor({ timeout: 15_000 });
    await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15_000 });
    await typeAtStart(page, 'DIRTY ');
    assert(await until(() => isDirty(page, 'fixture.txt'), 5_000), 'fixture.txt never went dirty');
    await makeActive(a.sessionId);
    const refused = await callTool(page, a.sessionId, 'close_session', { session: c.handle });
    assert(
      errCode(refused) === 'unsaved_changes' && errMessage(refused).includes('fixture.txt'),
      `dirty close: ${JSON.stringify(refused)}`,
    );
    await sleep(1_000);
    assert(await exists(page, c.sessionId), 'a dirty close still closed C');
    await makeActive(c.sessionId);
    assert(await isDirty(page, 'fixture.txt'), "the refused close dropped C's unsaved buffer");
    log('close_session refuses unsaved_changes naming fixture.txt; C and its buffer stay ✓');

    phase('close clean');
    await page.locator('.viewer__monaco .monaco-editor').first().click();
    await page.keyboard.press('Control+s');
    assert(
      await until(async () => !(await isDirty(page, 'fixture.txt')), 10_000),
      'fixture.txt never saved',
    );
    await makeActive(a.sessionId);
    const closedC = await callTool(page, a.sessionId, 'close_session', { session: c.handle });
    assert(closedC?.closed === c.sessionId, `clean close: ${JSON.stringify(closedC)}`);
    assert(await until(async () => !(await exists(page, c.sessionId)), 5_000), 'C survived');
    assert(await isActive(page, a.sessionId), 'closing C moved the view');
    log('close_session closes C once clean ✓');

    phase('other window');
    const w2 = await newWindow(app, page);
    await tapMcp(w2.page);
    const e = await openFake(w2.page, dirE);
    const fw = await openFake(w2.page, dirF);
    assert(await until(() => isActive(w2.page, fw.sessionId), 5_000), 'F not active in window 2');
    const far = await callTool(page, a.sessionId, 'focus_session', { session: e.handle });
    assert(errCode(far) === 'out_of_reach', `reach window, other window: ${JSON.stringify(far)}`);
    await sleep(1_000);
    assert(await isActive(w2.page, fw.sessionId), 'a reach-refused focus moved window 2');
    await setSessionPolicy(page, a.sessionId, 'focus_session', { reach: 'any' });
    const raised = await callTool(page, a.sessionId, 'focus_session', { session: e.handle });
    assert(raised?.focused === e.sessionId, `reach any focus: ${JSON.stringify(raised)}`);
    assert(await until(() => isActive(w2.page, e.sessionId), 5_000), 'E never became active');
    assert(await isActive(page, a.sessionId), "focusing window 2's E moved window 1's view");
    await setSessionPolicy(page, a.sessionId, 'close_session', { reach: 'any' });
    const closedF = await callTool(page, a.sessionId, 'close_session', { session: fw.handle });
    assert(closedF?.closed === fw.sessionId, `cross-window close: ${JSON.stringify(closedF)}`);
    assert(await until(async () => !(await exists(w2.page, fw.sessionId)), 5_000), 'F survived');
    log('reach window refuses window 2; reach any focuses E there and closes F in its window ✓');

    phase('self close');
    await setSessionPolicy(page, a.sessionId, 'close_session', { reach: 'self' });
    const bye = await callTool(page, a.sessionId, 'close_session', { session: a.handle });
    assert(bye?.closed === a.sessionId, `self close: ${JSON.stringify(bye)}`);
    assert(await until(async () => !(await exists(page, a.sessionId)), 5_000), 'A survived');
    log('a caller closing itself gets {closed} before it goes ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const p of [page, w2.page]) {
      for (const s of await sessions(p)) {
        await p.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
      }
    }
    assert(
      await until(
        async () => (await sessions(page)).length === 0 && (await sessions(w2.page)).length === 0,
        15_000,
      ),
      'sessions survived kill',
    );
    for (const dir of [dirA, dirB, dirC, dirD, dirE, dirF, extra])
      await removeDir(dir, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('app-sessions') },
);
