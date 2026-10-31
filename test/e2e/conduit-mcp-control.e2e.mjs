/**
 * conduit-mcp-control — an agent opens sessions and files through the control tools (spec
 * docs/specs/2026-10-27-conduit-mcp-control-tools.md §7; plan T6.2). Sessions run the fake MCP
 * agent, so the real shim, gate and per-connection tool lists are in the path:
 *   - main sets open_session On and worker sets it Off in their MCP tools dialogs; only worker's
 *     live connection changes (list_changed + a re-list without it), since open_session's
 *     default Ask is listed too (tool-policy spec §3.2);
 *   - a focused open from main, on screen, lands in main's window and project, rooted at the dir,
 *     and becomes active;
 *   - worker is refused tool_disabled and nothing appears;
 *   - focus:false leaves main active;
 *   - open_file, On by default, opens in main at line 40 with the cursor there.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionId,
  callTool,
  enableToolViaDialog,
  FAKE_AGENT_ID,
  fakeAgentProfile,
  openFake,
  records,
  sessions,
  sleep,
  tapMcp,
  toolsSeen,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, createProject, phase, removeDir, runScenario } from './harness.mjs';

const errCode = (r) => r?.error?.code;
// mcp:open resolves the long name (an 8.3 runner temp path would otherwise differ).
const sameDir = (a, b) =>
  realpathSync.native(a).replace(/\\/g, '/').toLowerCase() ===
  realpathSync.native(b).replace(/\\/g, '/').toLowerCase();

await runScenario(
  'conduit-mcp-control',
  async ({ app, page, log }) => {
    await tapMcp(page);
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-mcp-control-${label}-`));
    const dirA = temp('a');
    const dirB = temp('b');
    const opened = [temp('focused'), temp('background')];

    phase('setup');
    const projectId = await createProject(page, 'p');
    const main = await openFake(page, dirA, { projectId });
    const worker = await openFake(page, dirB);
    await enableToolViaDialog(page, main.sessionId, 'open_session', 'On');
    await enableToolViaDialog(page, worker.sessionId, 'open_session', 'Off');

    phase('list_changed');
    assert(
      await until(() => records(worker.sessionId, 'LIST_CHANGED').length > 0, 15_000),
      'worker never received tools/list_changed',
    );
    assert(
      await until(() => !toolsSeen(worker.sessionId).includes('open_session'), 10_000),
      `worker's re-list still has open_session: ${JSON.stringify(toolsSeen(worker.sessionId))}`,
    );
    assert(
      toolsSeen(main.sessionId).includes('open_session'),
      `main lacks open_session: ${JSON.stringify(toolsSeen(main.sessionId))}`,
    );
    assert(
      records(main.sessionId, 'LIST_CHANGED').length === 0,
      'main got a list_changed it had no reason for',
    );
    log('list_changed reached worker only ✓');

    phase('focused open');
    // open_session acts only while its caller is on screen (when: viewing).
    await page.locator(`.session[data-sessionid="${main.sessionId}"]`).click();
    assert(
      await until(async () => (await activeSessionId(page)) === main.sessionId, 5_000),
      'main never became active',
    );
    const r = await callTool(page, main.sessionId, 'open_session', {
      path: opened[0],
      agent: FAKE_AGENT_ID,
      focus: true,
    });
    assert(r.session_id && r.handle, `open_session result: ${JSON.stringify(r)}`);
    assert(
      await until(async () => (await sessions(page)).some((s) => s.id === r.session_id), 10_000),
      'the opened session never reached the renderer',
    );
    const created = (await sessions(page)).find((s) => s.id === r.session_id);
    assert(sameDir(created.home, opened[0]), `home ${created.home} ≠ ${opened[0]}`);
    assert(created.projectId === projectId, `projectId ${created.projectId} ≠ ${projectId}`);
    assert(app.windows().length === 1, `windows: ${app.windows().length}`);
    assert(
      await until(async () => (await activeSessionId(page)) === r.session_id, 10_000),
      `active is ${await activeSessionId(page)}, not the opened ${r.session_id}`,
    );
    const listed = await callTool(page, main.sessionId, 'list_sessions');
    assert(
      JSON.stringify(listed).includes(`"${r.handle}"`),
      `list_sessions lacks ${r.handle}: ${JSON.stringify(listed)}`,
    );
    log('focused open ✓');

    phase('disabled worker');
    const count = (await sessions(page)).length;
    const refused = await callTool(page, worker.sessionId, 'open_session', {
      path: dirB,
      agent: FAKE_AGENT_ID,
    });
    assert(errCode(refused) === 'tool_disabled', `worker: ${JSON.stringify(refused)}`);
    await sleep(1_000);
    assert((await sessions(page)).length === count, 'a refused open still created a session');
    log('worker refused tool_disabled ✓');

    phase('background open');
    await page.locator(`.session[data-sessionid="${main.sessionId}"]`).click();
    assert(
      await until(async () => (await activeSessionId(page)) === main.sessionId, 5_000),
      'main never became active',
    );
    const bg = await callTool(page, main.sessionId, 'open_session', {
      path: opened[1],
      agent: FAKE_AGENT_ID,
      focus: false,
    });
    assert(bg.session_id, `background open: ${JSON.stringify(bg)}`);
    assert(
      await until(async () => (await sessions(page)).some((s) => s.id === bg.session_id), 10_000),
      'the background session never reached the renderer',
    );
    // A focus switch would land within a frame of the state; give it well over that.
    await sleep(1_500);
    assert(
      (await activeSessionId(page)) === main.sessionId,
      `focus:false moved the active session to ${await activeSessionId(page)}`,
    );
    log('background open kept main active ✓');

    phase('open_file');
    writeFileSync(
      join(dirA, 'fixture.txt'),
      Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    const f = await callTool(page, main.sessionId, 'open_file', { path: 'fixture.txt', line: 40 });
    assert(f.opened && f.session_id === main.sessionId, `open_file: ${JSON.stringify(f)}`);
    await page.waitForFunction(
      () =>
        document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent ===
        'fixture.txt',
      null,
      { timeout: 15_000 },
    );
    const lineOf = () =>
      page.evaluate(
        () =>
          (window.monaco?.editor.getEditors() ?? [])
            .find((e) => e.getModel()?.uri.toString().endsWith('/fixture.txt'))
            ?.getPosition()?.lineNumber ?? null,
      );
    assert(await until(async () => (await lineOf()) === 40, 10_000), `cursor on ${await lineOf()}`);
    log('open_file at line 40 ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const d of [dirA, dirB, ...opened]) await removeDir(d, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('control') },
);
