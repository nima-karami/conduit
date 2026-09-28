/**
 * nav-keybindings-surfaces — the Slice 1 spike (docs/plans/2026-09-28-nav-keybindings.plan.md,
 * H1): with overrides seeded through the host, a rebound nav chord runs on the code viewer, a TS
 * plan block and a peek's embedded editor, and every default chord of the rebound command is
 * inert on each of them. The Settings UI is covered by nav-keybindings-settings.
 *
 * Every step asserts the new chord first (which proves the rule rebuild landed), then the old
 * one is inert. The diff viewer is not a surface here: its anonymous-URI models make the
 * navigation outcome language-dependent; it shares the same global rules.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs nav-keybindings-surfaces`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';
import {
  activeTab,
  cursorLine,
  focusEditor,
  makeNavFixture,
  openAtLineViaSearch,
  openViaTree,
  placeCursor,
  tapIndex,
  waitActive,
  waitCursor,
  waitForIndexReady,
} from './nav-history-fixture.mjs';

const IMPL = [
  'export function localTarget(): number { return 1; }',
  'export interface Shape { area(): number }',
  'export class Square implements Shape { area(): number { return 2; } }',
  'export const n = localTarget();',
];
const PLAN_TS = [
  'function localTarget(): number { return 1; }',
  'interface Shape { area(): number }',
  'class Square implements Shape { area(): number { return 2; } }',
  'const n = localTarget();',
];

/** Persist `shortcuts` through the host exactly as Settings does, and wait for the echo. */
async function setShortcuts(page, shortcuts) {
  await page.evaluate(
    (sc) =>
      new Promise((resolve, reject) => {
        const want = JSON.stringify(Object.entries(sc).sort());
        let sent = false;
        let off = () => {};
        const timer = setTimeout(() => {
          off();
          reject(new Error('setShortcuts: the host never echoed the new shortcuts'));
        }, 10000);
        off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          if (!sent) {
            sent = true;
            window.agentDeck.post({
              type: 'updateSettings',
              settings: { ...m.settings, shortcuts: sc },
            });
            return;
          }
          if (JSON.stringify(Object.entries(m.settings.shortcuts ?? {}).sort()) === want) {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
    shortcuts,
  );
  // The renderer's own subscriber got the same message; give React one commit to rebuild rules.
  await page.waitForTimeout(300);
}

/** Caret on the nth `token` in the plan block's editor, focused. */
async function caretInPlan(page, token, nth = 0) {
  const ok = await page.evaluate(
    ({ tok, n }) => {
      const ed = (window.monaco?.editor.getEditors() ?? []).find(
        (e) =>
          e.getDomNode()?.closest('.plan__code') && e.getModel()?.getValue().includes('Square'),
      );
      const model = ed?.getModel();
      if (!ed || !model) return false;
      const text = model.getValue();
      let off = -1;
      for (let i = 0; i <= n; i++) off = text.indexOf(tok, off + 1);
      if (off < 0) return false;
      ed.setPosition(model.getPositionAt(off + 1));
      ed.focus();
      return true;
    },
    { tok: token, n: nth },
  );
  assert(ok, `caretInPlan: "${token}" #${nth} not found in the plan block`);
}

function planLine(page) {
  return page.evaluate(() => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find(
      (e) => e.getDomNode()?.closest('.plan__code') && e.getModel()?.getValue().includes('Square'),
    );
    return ed?.getPosition()?.lineNumber ?? null;
  });
}

async function waitPlanLine(page, line, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if ((await planLine(page)) === line) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

/** The peek's embedded editor: model path + caret, or null when no peek is open. */
function peekState(page) {
  return page.evaluate(() => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find((e) =>
      e.getDomNode()?.closest('.zone-widget'),
    );
    if (!ed?.getDomNode()?.isConnected) return null;
    return { path: ed.getModel()?.uri.path ?? '', line: ed.getPosition()?.lineNumber ?? null };
  });
}

async function snapshot(page) {
  return JSON.stringify({
    tab: await activeTab(page),
    line: await cursorLine(page),
    peek: await peekState(page),
  });
}

/** Presses `key` and asserts nothing observable moved within 1 s. */
async function assertInert(page, key, what) {
  const before = await snapshot(page);
  await page.keyboard.press(key);
  await page.waitForTimeout(1000);
  const after = await snapshot(page);
  assert(after === before, `${what}: ${key} must be inert, went ${before} → ${after}`);
}

runScenario('nav-keybindings-surfaces', async ({ page, log }) => {
  const root = makeNavFixture([]);
  writeFileSync(join(root, 'impl.ts'), `${IMPL.join('\n')}\n`);
  const plans = join(root, '.conduit', 'plans');
  mkdirSync(plans, { recursive: true });

  await tapIndex(page);
  await openSession(page, { path: root });
  await waitForIndexReady(page, log);

  // ── plan block ──────────────────────────────────────────────────────────────────────────
  writeFileSync(join(plans, 'nav.md'), `# Nav\n\n\`\`\`ts\n${PLAN_TS.join('\n')}\n\`\`\`\n`);
  const toast = page.locator('.toast', { hasText: 'Agent updated plan' }).first();
  await toast.waitFor({ state: 'visible', timeout: 10000 });
  await toast.locator('.toast__action', { hasText: 'Open' }).click();
  await page
    .locator('.plan__code .monaco-editor')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });

  await caretInPlan(page, 'localTarget', 1);
  await page.keyboard.press('F12');
  assert(
    await waitPlanLine(page, 1, 15000),
    `baseline: F12 at default must navigate in the plan block (line 1), at ${await planLine(page)}`,
  );
  log('baseline: F12 at default navigates in the plan block ✓');

  // AC-5c mirror: only Implementations moves. Ctrl+F12 must now reach nothing — in particular not
  // Definition's isWeb Ctrl+F12, which on `localTarget` would jump to line 1.
  await setShortcuts(page, { goToImplementation: 'Alt+I' });
  await caretInPlan(page, 'area', 0);
  await page.keyboard.press('Alt+I');
  assert(
    await waitPlanLine(page, 3),
    `AC-5c mirror: Alt+I in the plan block must run Implementations (line 3), at ${await planLine(page)}`,
  );
  await caretInPlan(page, 'localTarget', 1);
  await page.keyboard.press('Control+F12');
  await page.waitForTimeout(1000);
  assert(
    (await planLine(page)) === 4,
    `AC-5c mirror: Ctrl+F12 in the plan block must be inert, at ${await planLine(page)}`,
  );
  log('AC-5c mirror plan block: Implementations on Alt+I, Ctrl+F12 inert ✓');

  await setShortcuts(page, { goToDefinition: 'Alt+D', goToReferences: 'Alt+R' });

  await caretInPlan(page, 'localTarget', 1);
  await page.keyboard.press('Alt+D');
  assert(
    await waitPlanLine(page, 1),
    `AC-5: Alt+D in the plan block, line ${await planLine(page)}`,
  );
  await caretInPlan(page, 'localTarget', 1);
  await page.keyboard.press('F12');
  await page.waitForTimeout(1000);
  assert((await planLine(page)) === 4, 'AC-5: F12 in the plan block must be inert');
  log('AC-5 plan block follows the rebind; F12 inert ✓');

  await caretInPlan(page, 'area', 0);
  await page.keyboard.press('Control+F12');
  assert(
    await waitPlanLine(page, 3),
    `AC-5c: Ctrl+F12 in the plan block must run Implementations (line 3), at ${await planLine(page)}`,
  );
  log('AC-5c plan block: Ctrl+F12 runs Implementations, never Definition ✓');

  // ── code viewer ─────────────────────────────────────────────────────────────────────────
  await openAtLineViaSearch(page, 'navTarget();', 'a.ts', 12);
  await page.keyboard.press('Alt+D');
  assert(
    await waitActive(page, 'b.ts'),
    `AC-2: Alt+D should open b.ts, on ${await activeTab(page)}`,
  );
  assert(
    await waitCursor(page, 40),
    `AC-2: Alt+D should land on b.ts:40, at ${await cursorLine(page)}`,
  );
  log('AC-2 Alt+D navigates cross-file ✓');

  await page.keyboard.press('Alt+ArrowLeft');
  assert(await waitActive(page, 'a.ts'), 'back to a.ts');
  assert(await waitCursor(page, 12), 'back on a.ts:12');
  await focusEditor(page);
  await assertInert(page, 'F12', 'AC-3 code viewer');
  log('AC-3 F12 inert in the code viewer ✓');

  // From the import (reference 1 of a.ts:1, a.ts:12, b.ts:40) so the peek's own F12 — Monaco's
  // goToNextReference, live in a peek once revealDefinition's F12 is removed — steps to a.ts:12,
  // which Definition (b.ts:40) can never be mistaken for.
  await placeCursor(page, `${root}/a.ts`, 'navTarget', 0);
  await page.keyboard.press('Alt+R');
  const peekOpen = await page
    .waitForFunction(
      () =>
        !!document.querySelector(
          '.monaco-editor .zone-widget .peekview-widget, .monaco-editor .peekview-widget',
        ),
      null,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(peekOpen, 'AC-4: Alt+R should open the references peek');
  log('AC-4 Alt+R opens the references peek ✓');

  // AC-5b (revised to Definition, see the plan's Spec staleness): the peek's embedded editor.
  const embedded = await page.waitForFunction(
    () => {
      const ed = (window.monaco?.editor.getEditors() ?? []).find((e) =>
        e.getDomNode()?.closest('.zone-widget'),
      );
      const model = ed?.getModel();
      if (!ed || !model) return null;
      const text = model.getValue();
      const off = text.indexOf('navTarget');
      if (off < 0 || !model.uri.path.endsWith('/a.ts')) return null;
      ed.setPosition(model.getPositionAt(off + 1));
      ed.focus();
      return ed.hasTextFocus() ? model.uri.path : null;
    },
    null,
    { timeout: 10000 },
  );
  log(`peek embedded editor focused on ${await embedded.jsonValue()}`);
  const beforeF12 = await snapshot(page);
  await page.keyboard.press('F12');
  await page.waitForTimeout(1000);
  const afterF12 = await snapshot(page);
  const f12Peek = await peekState(page);
  assert(
    (await activeTab(page)) === 'a.ts' && !f12Peek?.path.endsWith('/b.ts'),
    `AC-5b: F12 in the peek must not run Definition (b.ts:40), went ${beforeF12} → ${afterF12}`,
  );
  log(`AC-5b F12 in the peek did not run Definition: ${beforeF12} → ${afterF12}`);
  const refocused = await page.evaluate(() => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find(
      (e) => e.getDomNode()?.isConnected && e.getDomNode()?.closest('.zone-widget'),
    );
    const model = ed?.getModel();
    if (!ed || !model) return false;
    ed.setPosition(model.getPositionAt(model.getValue().indexOf('navTarget') + 1));
    ed.focus();
    return ed.hasTextFocus();
  });
  assert(refocused, 'AC-5b: the peek must still be open with its embedded editor focusable');
  const beforeAltD = await snapshot(page);
  await page.keyboard.press('Alt+D');
  let moved = false;
  for (let i = 0; i < 100 && !moved; i++) {
    const tab = await activeTab(page);
    const peek = await peekState(page);
    moved =
      (tab === 'b.ts' && (await cursorLine(page)) === 40) ||
      (!!peek && peek.path.endsWith('/b.ts') && peek.line === 40);
    if (!moved) await page.waitForTimeout(100);
  }
  assert(
    moved,
    `AC-5b: Alt+D in the peek's embedded editor must reach b.ts:40, went ${beforeAltD} → ${await snapshot(page)}`,
  );
  log('AC-5b peek embedded editor: F12 does not run Definition, Alt+D does ✓');
  await page.keyboard.press('Escape');

  await openViaTree(page, root, ['impl.ts']);
  assert(await waitActive(page, 'impl.ts'), 'impl.ts active');
  await placeCursor(page, `${root}/impl.ts`, 'area', 0);
  await page.keyboard.press('Control+F12');
  assert(
    await waitCursor(page, 3, 15000),
    `AC-5c code viewer: Ctrl+F12 must run Implementations (line 3), at ${await cursorLine(page)}`,
  );
  log('AC-5c code viewer: Ctrl+F12 runs Implementations ✓');

  // AC-7: swap. Shift+F12 was References' default and F12 Definition's.
  await setShortcuts(page, { goToDefinition: 'Shift+F12', goToReferences: 'F12' });
  await openAtLineViaSearch(page, 'navTarget();', 'a.ts', 12);
  await page.keyboard.press('Shift+F12');
  assert(await waitActive(page, 'b.ts'), 'AC-7: Shift+F12 should open b.ts');
  assert(await waitCursor(page, 40), 'AC-7: Shift+F12 should land on b.ts:40');
  await page.keyboard.press('Alt+ArrowLeft');
  assert(await waitActive(page, 'a.ts'), 'AC-7: back to a.ts');
  assert(await waitCursor(page, 12), 'AC-7: back on a.ts:12');
  await focusEditor(page);
  await page.keyboard.press('F12');
  const swapPeek = await page
    .waitForFunction(() => !!document.querySelector('.monaco-editor .peekview-widget'), null, {
      timeout: 15000,
    })
    .then(() => true)
    .catch(() => false);
  assert(swapPeek, 'AC-7: F12 should open the references peek');
  assert((await activeTab(page)) === 'a.ts', 'AC-7: F12 must not navigate to the definition');
  log('AC-7 swap: Shift+F12 → definition, F12 → references ✓');

  // AC-5c mirror in the code viewer.
  await setShortcuts(page, { goToImplementation: 'Alt+I' });
  await page.keyboard.press('Escape');
  await openViaTree(page, root, ['impl.ts']);
  assert(await waitActive(page, 'impl.ts'), 'AC-5c mirror: impl.ts active');
  await placeCursor(page, `${root}/impl.ts`, 'area', 0);
  await page.keyboard.press('Alt+I');
  assert(
    await waitCursor(page, 3, 15000),
    `AC-5c mirror code viewer: Alt+I must run Implementations (line 3), at ${await cursorLine(page)}`,
  );
  await placeCursor(page, `${root}/impl.ts`, 'localTarget', 1);
  await assertInert(page, 'Control+F12', 'AC-5c mirror code viewer');
  log('AC-5c mirror code viewer: Implementations on Alt+I, Ctrl+F12 inert ✓');
});
