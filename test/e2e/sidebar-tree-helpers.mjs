/**
 * Shared driver for the sidebar agent-tree scenarios (docs/specs/2026-11-02-sidebar-agent-tree.md
 * §3–§6; selector contract: docs/plans/2026-11-02-sidebar-agent-tree.plan.md S0 plus the lead's
 * amendment — group headers are level-1 treeitems that are siblings of the rows, rows sit at
 * depth+2, in one flat keyed list under `[data-agent-tree]`).
 *
 * Children are real: a fake MCP agent calls `open_session`, so the host stamps `openedBy` exactly
 * as it does for a real CLI. Nothing here builds ancestry in the renderer.
 */
import {
  callTool,
  FAKE_AGENT_ID,
  records,
  sessions,
  setSessionPolicy,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert } from './harness.mjs';

/** One escaped attribute value for a CSS selector. */
const attr = (v) => String(v).replace(/["\\]/g, '\\$&');

/** The exact-text matcher Playwright's `hasText` needs to tell `Move to space…` from a prefix. */
export const exact = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

const rowSel = (sessionId) => `[data-agent-tree] .session[data-sessionid="${attr(sessionId)}"]`;
export const row = (page, sessionId) => page.locator(rowSel(sessionId));
export const spaceRow = (page, key) =>
  page.locator(`.sidebar button[data-space-id="${attr(key)}"]`);
export const groupHeader = (page, key) =>
  page.locator(`[data-agent-tree] button.proj__label[data-agent-group="${attr(key)}"]`);

/**
 * The tree's direct items in DOM (= pointer and keyboard) order:
 * `{ kind: 'group', key, expanded, label }` or `{ kind: 'row', id, level, expanded, label }`.
 * `expanded` is the raw aria-expanded attribute (null when absent).
 */
export function treeItems(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-agent-tree] > [role="treeitem"]')].map((el) =>
      el.hasAttribute('data-agent-group')
        ? {
            kind: 'group',
            key: el.getAttribute('data-agent-group'),
            level: Number(el.getAttribute('aria-level')),
            expanded: el.getAttribute('aria-expanded'),
            label: el.getAttribute('aria-label'),
          }
        : {
            kind: 'row',
            id: el.getAttribute('data-sessionid'),
            level: Number(el.getAttribute('aria-level')),
            expanded: el.getAttribute('aria-expanded'),
            label: el.getAttribute('aria-label'),
          },
    ),
  );
}

/** The ids of the rendered rows, in order. */
export async function rowIds(page) {
  return (await treeItems(page)).filter((i) => i.kind === 'row').map((i) => i.id);
}

/** Wait until the tree renders exactly these rows, in any order. */
export async function waitRows(page, ids, what, timeout = 10_000) {
  const ok = await page
    .waitForFunction(
      (want) => {
        const got = [...document.querySelectorAll('[data-agent-tree] .session')].map((c) =>
          c.getAttribute('data-sessionid'),
        );
        return got.length === want.length && want.every((id) => got.includes(id));
      },
      ids,
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );
  assert(
    ok,
    `${what}: rows should be ${JSON.stringify(ids)}, got ${JSON.stringify(await rowIds(page))}`,
  );
}

/** The status group a row renders under: the nearest group header before it in the flat list. */
export async function groupOf(page, sessionId) {
  let group = null;
  for (const item of await treeItems(page)) {
    if (item.kind === 'group') group = item.key;
    else if (item.id === sessionId) return group;
  }
  return undefined;
}

/** Poll `read` until `want(value)` holds; fail with the last value seen. */
export async function waitFact(read, want, what, ms = 15_000) {
  let last;
  const ok = await until(async () => {
    last = await read();
    return want(last);
  }, ms);
  assert(ok, `${what} (last: ${JSON.stringify(last)})`);
  return last;
}

/** Wait for a row's accessible name to equal `expected`. */
export function waitLabel(page, sessionId, expected, what, ms = 15_000) {
  return waitFact(
    () =>
      row(page, sessionId)
        .getAttribute('aria-label', { timeout: 2_000 })
        .catch(() => null),
    (l) => l === expected,
    `${what}: label should be ${JSON.stringify(expected)}`,
    ms,
  );
}

/** Wait for a row to render under `group` (a data-agent-group key). */
export function waitGroup(page, sessionId, group, what, ms = 15_000) {
  return waitFact(
    () => groupOf(page, sessionId),
    (g) => g === group,
    `${what}: ${sessionId} should be under ${group}`,
    ms,
  );
}

export const sessionOf = async (page, id) => (await sessions(page)).find((s) => s.id === id);

/** The server's display name for a session. */
export async function nameOf(page, id) {
  const s = await sessionOf(page, id);
  assert(s, `no session ${id}`);
  return s.name;
}

/**
 * Have `parentId` (a fake MCP agent) open a child through MCP `open_session`, without taking the
 * view, and wait for the child's own MCP handshake so it can open children in turn. The opener's
 * layer is On / always so a caller off screen may still open (tool-policy spec §3.2).
 * @returns {Promise<string>} the child's session id
 */
export async function openChild(page, parentId, { path, label }) {
  await setSessionPolicy(page, parentId, 'open_session', { access: 'on', when: 'always' });
  const r = await callTool(page, parentId, 'open_session', {
    path: path.replace(/\\/g, '/'),
    agent: FAKE_AGENT_ID,
    label,
    focus: false,
  });
  assert(r?.session_id && !r.error, `open_session from ${parentId}: ${JSON.stringify(r)}`);
  const id = r.session_id;
  assert(
    await until(() => records(id, 'READY').some((x) => x.tools.includes('open_session')), 30_000),
    `the child ${id} never finished its MCP handshake`,
  );
  const s = await waitFact(
    () => sessionOf(page, id),
    (x) => x?.openedBy?.sessionId === parentId,
    `the host should stamp ${id} as opened by ${parentId}`,
  );
  return s.id;
}

/** Kill every session this window owns and wait for none to be left. */
export async function killAll(page) {
  for (const s of await sessions(page))
    await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
  assert(
    await until(async () => (await sessions(page)).length === 0, 15_000),
    'sessions survived kill',
  );
}

/**
 * Drag a row onto a Space row with synthesized DragEvents sharing one DataTransfer (as
 * terminal-drop does). The dragend reports this window's own centre, so the host's cross-window
 * hit-test is a no-op. Returns whether the Space accepted the drag and showed its drop cue.
 */
export async function dragRowOntoSpace(app, page, sessionId, spaceKey) {
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  return page.evaluate(
    async ({ rowS, spaceS, sx, sy }) => {
      const src = document.querySelector(rowS);
      const target = document.querySelector(spaceS);
      if (!src || !target) return { error: `missing ${src ? spaceS : rowS}` };
      const dt = new DataTransfer();
      const fire = (el, type, extra = {}) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }),
        );
      // React commits the drop cue on the next render.
      const tick = () => new Promise((r) => setTimeout(r, 60));
      fire(src, 'dragstart');
      await tick();
      const accepted = !fire(target, 'dragover');
      await tick();
      const cue = target.classList.contains('space--drop');
      fire(target, 'drop');
      await tick();
      fire(src, 'dragend', { screenX: sx, screenY: sy });
      return { accepted, cue };
    },
    {
      rowS: rowSel(sessionId),
      spaceS: `.sidebar button[data-space-id="${attr(spaceKey)}"]`,
      sx: Math.round(bounds.x + bounds.width / 2),
      sy: Math.round(bounds.y + bounds.height / 2),
    },
  );
}

/** Session menu → Move to space… → the picker's row for `spaceName`. */
export async function moveViaPicker(page, sessionId, spaceName) {
  await row(page, sessionId).locator('.session__name').click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { timeout: 5_000 });
  await page.locator('.ctxmenu__item', { hasText: exact('Move to space…') }).click();
  await page.waitForSelector('.projpicker', { timeout: 5_000 });
  await page.locator('.projpicker__row', { hasText: exact(spaceName) }).click();
  await page.waitForSelector('.projpicker', { state: 'detached', timeout: 5_000 });
}

/** What holds keyboard focus: a row's id, `group:<key>`, or the element's aria-label. */
export function focused(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    if (el.hasAttribute('data-sessionid')) return el.getAttribute('data-sessionid');
    if (el.hasAttribute('data-agent-group')) return `group:${el.getAttribute('data-agent-group')}`;
    return el.getAttribute('aria-label');
  });
}

/** Press `key` and wait for focus to land on `want` (see `focused`). */
export async function pressAndExpectFocus(page, key, want, what) {
  await page.keyboard.press(key);
  await waitFact(
    () => focused(page),
    (f) => f === want,
    `${what}: focus should be ${want}`,
    5_000,
  );
}
