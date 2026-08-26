/**
 * Go to Definition flow matrix — first-party resolution + path identity
 * (docs/specs/2026-08-21-goto-definition-flows.md rows 1–17, 42–44).
 *
 * Asserts the spec's TARGET behaviour, so the pre-fix build is expected to fail the ❌/🔇/⚠️
 * rows. Every row is collected and printed; the scenario fails at the END, once.
 *
 * Run: node test/e2e/run-smoke.mjs goto-matrix-firstparty   (needs `npm run build` first)
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGotoFixture } from './fixtures/goto/build-fixture.mjs';
import {
  clearTransients,
  closeAllDocs,
  createMatrix,
  describe,
  landed,
  observe,
  openDoc,
  openViaTree,
  placeCursor,
  tapIndex,
  trigger,
  waitForIndexReady,
} from './goto-matrix.mjs';
import { openSession, runScenario } from './harness.mjs';

runScenario('goto-matrix-firstparty', async ({ app, page, log }) => {
  const base = mkdtempSync(join(tmpdir(), 'goto-fx-fp-'));
  const { root } = buildGotoFixture(base);
  log('fixture at', root);

  await tapIndex(page);
  const sid = await openSession(page, { path: root });

  // ── Row 39 / 45 run BEFORE the index is ready, by construction ────────────────────────
  const m = createMatrix('first-party', log);
  const f = (rel) => join(root, rel);

  await openDoc(app, page, sid, f('src/feedback/first-open.ts'));
  await m.row(
    '39',
    { flow: 'F12 before TS providers register', trigger: 'f12', current: '🔇', target: '✅' },
    async () => {
      await placeCursor(page, f('src/feedback/first-open.ts'), 'firstOpen', 0);
      const { after } = await trigger(page, 'f12');
      const spoke = !!after.overlay || after.toasts.length > 0;
      return {
        pass: spoke,
        observed: spoke ? describe(after) : `silent — ${describe(after)}`,
      };
    },
  );
  await clearTransients(page);

  await waitForIndexReady(page, log);

  // ── First-party resolution ────────────────────────────────────────────────────────────
  /** Open `file`, put the cursor on `token`, fire `kind`, expect to land on `marker`. */
  const nav = async (file, token, nth, kind, expectFile, marker) => {
    await clearTransients(page);
    await openDoc(app, page, sid, f(file));
    await placeCursor(page, f(file), token, nth);
    const { after } = await trigger(page, kind);
    return { after, ok: landed(after, expectFile, marker) };
  };

  const simple = (id, meta, file, token, nth, kind, expectFile, marker) =>
    m.row(id, meta, async () => {
      const { after, ok } = await nav(file, token, nth, kind, expectFile, marker);
      return { pass: ok, observed: describe(after) };
    });

  await simple(
    '1',
    { flow: 'same-file symbol', trigger: 'f12', current: '✅', target: '✅' },
    'src/first/same-file.ts',
    'markerR01SameFile',
    1,
    'f12',
    'same-file.ts',
    'export function markerR01SameFile',
  );
  await simple(
    '2',
    { flow: 'relative ./foo', trigger: 'menu', current: '✅', target: '✅' },
    'src/first/rel-consumer.ts',
    'markerR02RelTarget',
    1,
    'menu',
    'rel-target.ts',
    'markerR02RelTarget',
  );
  await simple(
    '3',
    { flow: 'extension omitted, .ts wins', trigger: 'f12', current: '✅', target: '✅' },
    'src/first/ext-consumer.ts',
    'markerR03ExtTs',
    1,
    'f12',
    'ext/pick.ts',
    'markerR03ExtTs',
  );
  await simple(
    '4',
    { flow: '.mts with TS-only syntax', trigger: 'f12', current: '⚠️', target: '✅' },
    'src/first/mts-consumer.ts',
    'MarkerR04MtsIface',
    1,
    'f12',
    'mts-target.mts',
    'MarkerR04MtsIface',
  );
  await simple(
    '5',
    { flow: 'directory import → index.ts', trigger: 'menu', current: '✅', target: '✅' },
    'src/first/dir-consumer.ts',
    'markerR05DirIndex',
    1,
    'menu',
    'dirmod/index.ts',
    'markerR05DirIndex',
  );
  await simple(
    '6',
    { flow: 'barrel → leaf, not the barrel', trigger: 'f12', current: '✅', target: '✅' },
    'src/first/barrel-consumer.ts',
    'markerR06BarrelLeaf',
    1,
    'f12',
    'barrel/leaf.ts',
    'markerR06BarrelLeaf',
  );
  await simple(
    '7',
    { flow: 'export * chain, 3 levels', trigger: 'f12', current: '✅', target: '✅' },
    'src/first/chain-consumer.ts',
    'markerR07ChainDeep',
    1,
    'f12',
    'chain/c.ts',
    'markerR07ChainDeep',
  );
  await simple(
    '8',
    { flow: 'export { X as Y } rename', trigger: 'menu', current: '✅', target: '✅' },
    'src/first/rename-consumer.ts',
    'markerR08RenameAlias',
    1,
    'menu',
    'rename/origin.ts',
    'markerR08RenameOrigin',
  );
  await simple(
    '9',
    { flow: 'export default function', trigger: 'f12', current: '✅', target: '✅' },
    'src/first/default-consumer.ts',
    'markerR09Local',
    1,
    'f12',
    'default-export.ts',
    'markerR09DefaultFn',
  );
  await simple(
    '10',
    { flow: 'import type through a barrel', trigger: 'f12', current: '✅', target: '✅' },
    'src/first/type-consumer.ts',
    'MarkerR10TypeOnly',
    1,
    'f12',
    'types/type-decl.ts',
    'MarkerR10TypeOnly',
  );
  await simple(
    '11',
    { flow: 'JSX <Foo /> → component', trigger: 'menu', current: '✅', target: '✅' },
    'src/first/comp/use-widget.tsx',
    'MarkerR11Widget',
    1,
    'menu',
    'comp/marker-widget.tsx',
    'MarkerR11Widget',
  );

  await m.row(
    '12',
    { flow: 'multiple results → peek, no toast', trigger: 'f12', current: '⚠️', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/first/multi-decl.ts'));
      await placeCursor(page, f('src/first/multi-decl.ts'), 'MarkerR12Multi', 2);
      const { after } = await trigger(page, 'f12');
      const spurious = after.toasts.some((t) => /still indexing|hasn’t been indexed/i.test(t));
      return { pass: after.peek && !spurious, observed: describe(after) };
    },
  );
  await m.row(
    '13',
    { flow: 'cursor on the declaration → refs peek', trigger: 'f12', current: '⚠️', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/first/self-decl.ts'));
      await placeCursor(page, f('src/first/self-decl.ts'), 'markerR13SelfDecl', 0);
      const { after } = await trigger(page, 'f12');
      const spurious = after.toasts.some((t) => /still indexing|hasn’t been indexed/i.test(t));
      return { pass: after.peek && !spurious, observed: describe(after) };
    },
  );

  await simple(
    '14',
    { flow: 'ambient declare global (.d.ts)', trigger: 'f12', current: '✅', target: '✅' },
    'src/first/uses-global.ts',
    'markerR14AmbientGlobal',
    0,
    'f12',
    'first/globals.d.ts',
    'markerR14AmbientGlobal',
  );
  await simple(
    '15',
    { flow: 'declaration under .storybook/', trigger: 'menu', current: '❌', target: '✅' },
    'src/first/uses-storybook.ts',
    'markerR15StorybookGlobal',
    0,
    'menu',
    '.storybook/types.ts',
    'markerR15StorybookGlobal',
  );

  // 42 — the tree opens `C:\…`; the navigation's URI path lowercases the drive. One file must
  // not become two tabs with separate dirty/view state. Runs BEFORE the dirty-tab rows so the
  // tab sweep it starts with can't collide with an unsaved buffer's save/discard modal.
  await m.row(
    '42',
    { flow: 'drive-letter casing → duplicate tab', trigger: 'f12', current: '⚠️', target: '✅' },
    async () => {
      await clearTransients(page);
      await closeAllDocs(page);
      const treePath = await openViaTree(page, root, ['src', 'first', 'rel-target.ts']);
      await page.waitForFunction(
        (want) =>
          (window.monaco?.editor.getEditors() ?? []).some(
            (e) => e.getModel()?.uri.path.toLowerCase() === `/${want.toLowerCase()}`,
          ),
        treePath,
        { timeout: 20000 },
      );
      const before = await observe(page);
      await openDoc(app, page, sid, f('src/first/rel-consumer.ts'));
      await placeCursor(page, f('src/first/rel-consumer.ts'), 'markerR02RelTarget', 1);
      const { after } = await trigger(page, 'f12');
      const dupes = after.tabs.filter((t) => t.title === 'rel-target.ts');
      return {
        pass: dupes.length === 1,
        observed: `tree key ${treePath} (${before.tabs.length} tab(s) before); after nav ${dupes.length} tab(s) titled rel-target.ts, model uri ${after.path}`,
      };
    },
  );

  // 16 / 44 — the target is open AND dirty: the mirror model must win, and the navigation must
  // land in the tab that already exists rather than opening a second one.
  await m.row(
    '16',
    { flow: 'unsaved edits in the target', trigger: 'f12', current: '✅', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/first/dirty-target.ts'));
      const shifted = await page.evaluate(
        (p) => {
          const ed = window.monaco.editor
            .getEditors()
            .find((e) => e.getModel()?.uri.path.toLowerCase() === `/${p.toLowerCase()}`);
          const model = ed?.getModel();
          if (!ed || !model) return 0;
          ed.executeEdits('goto-matrix', [
            { range: new window.monaco.Range(1, 1, 1, 1), text: '\n\n\n\n\n' },
          ]);
          const off = model.getValue().indexOf('markerR16DirtyTarget');
          return model.getPositionAt(off).lineNumber;
        },
        f('src/first/dirty-target.ts').replace(/\\/g, '/'),
      );
      await openDoc(app, page, sid, f('src/first/dirty-consumer.ts'));
      await placeCursor(page, f('src/first/dirty-consumer.ts'), 'markerR16DirtyTarget', 1);
      const { after } = await trigger(page, 'f12');
      const ok = landed(after, 'dirty-target.ts', 'markerR16DirtyTarget') && after.line === shifted;
      return {
        pass: ok,
        observed: `${describe(after)} (dirty decl at line ${shifted})`,
      };
    },
  );
  await m.row(
    '44',
    { flow: 'target already open in a dirty tab', trigger: 'f12', current: '⚠️', target: '✅' },
    async () => {
      const after = await observe(page);
      const dupes = after.tabs.filter((t) => t.title === 'dirty-target.ts');
      return {
        pass: dupes.length === 1 && dupes.some((t) => t.active),
        observed: `${dupes.length} tab(s) titled dirty-target.ts, active=${dupes.filter((t) => t.active).length}; strip=[${after.tabs.map((t) => t.title).join(', ')}]`,
      };
    },
  );

  await m.row(
    '17',
    { flow: 'source file > 2 MB', trigger: 'menu', current: '🔇', target: '⚠️' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/first/huge-consumer.ts'));
      await placeCursor(page, f('src/first/huge-consumer.ts'), 'markerR17HugeTail', 1);
      const { after } = await trigger(page, 'menu');
      const honest =
        after.toasts.some((t) => /skipp|too large|not indexed/i.test(t)) ||
        /skipp|too large|not indexed/i.test(after.overlay);
      return { pass: honest, observed: describe(after) };
    },
  );

  // ── Path identity ─────────────────────────────────────────────────────────────────────
  await m.row(
    '43',
    { flow: 'path containing #', trigger: 'f12', current: '🔇', target: '✅' },
    async () => {
      const { after, ok } = await nav(
        'src/first/uses-hash.ts',
        'markerR43HashDir',
        1,
        'f12',
        'c#/mod.ts',
        'markerR43HashDir',
      );
      return { pass: ok, observed: describe(after) };
    },
  );
  await m.row(
    '43b',
    { flow: 'directory name with a space', trigger: 'f12', current: '?', target: '✅' },
    async () => {
      const { after, ok } = await nav(
        'src/first/uses-space.ts',
        'markerR43bSpaceDir',
        1,
        'f12',
        'with space/mod.ts',
        'markerR43bSpaceDir',
      );
      return { pass: ok, observed: describe(after) };
    },
  );

  // 35's fixture half lives here too: prove a file written AFTER the index still resolves.
  await m.row(
    '35',
    { flow: 'file created after the index ran', trigger: 'f12', current: '❌', target: '✅' },
    async () => {
      writeFileSync(
        join(root, 'src/late/late-target.ts'),
        'export const markerR35LateFile = 35;\n',
        'utf8',
      );
      await page.waitForTimeout(1200); // let any fsChanged watcher fire
      const { after, ok } = await nav(
        'src/late/late-consumer.ts',
        'markerR35LateFile',
        1,
        'f12',
        'late/late-target.ts',
        'markerR35LateFile',
      );
      return { pass: ok, observed: describe(after) };
    },
  );

  m.finish();
});
