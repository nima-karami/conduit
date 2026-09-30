/**
 * Shared fixture and Explorer/Monaco drivers for the file-integrity-* scenarios. Every scenario
 * gets the same project, so each phase sees the tree it was written against.
 */

import { runAutoSave } from './auto-save-helpers.mjs';
import { phase } from './harness.mjs';

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const row = (page, name) =>
  page
    .locator('.filerow', {
      has: page.locator('.filerow__name', { hasText: new RegExp(`^${esc(name)}$`) }),
    })
    .first();

/** Model URIs, normalised to forward slashes and a lowercase drive so they can be matched. */
export const modelUris = (page) =>
  page.evaluate(() =>
    window.monaco.editor.getModels().map((m) => decodeURIComponent(m.uri.toString()).toLowerCase()),
  );
export const modelValueAt = (page, tail) =>
  page.evaluate(
    (t) =>
      window.monaco.editor
        .getModels()
        .find((m) => decodeURIComponent(m.uri.toString()).toLowerCase().endsWith(t))
        ?.getValue() ?? null,
    tail,
  );
export const cursorIn = (page, tail) =>
  page.evaluate((t) => {
    const ed = window.monaco.editor.getEditors().find((e) =>
      decodeURIComponent(e.getModel()?.uri.toString() ?? '')
        .toLowerCase()
        .endsWith(t),
    );
    const p = ed?.getPosition();
    return p ? { line: p.lineNumber, column: p.column } : null;
  }, tail);

/** A real F2 on the row: focus it with a click, press F2, type the new name, commit with Enter. */
export async function renameRow(page, from, to) {
  await row(page, from).click();
  await page.keyboard.press('F2');
  const input = page.locator('.filerow__input').first();
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill(to);
  await input.press('Enter');
  await input.waitFor({ state: 'detached', timeout: 5000 });
}

export async function editAt(page, line, column, text) {
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.evaluate(
    ({ l, c }) => {
      const ed = window.monaco.editor.getEditors().find((e) => e.hasTextFocus());
      ed.setPosition({ lineNumber: l, column: c });
    },
    { l: line, c: column },
  );
  await page.keyboard.type(text);
}

export async function deleteRow(page, name) {
  await row(page, name).click();
  await page.keyboard.press('Delete');
  await page.waitForSelector('.confirm', { state: 'visible', timeout: 8000 });
  await page.locator('.confirm .btn--danger').click();
}

export const deletedBanner = (page) =>
  page.locator('.viewer__banner--warn', { hasText: 'was deleted on disk' });

export async function overwrite(page) {
  await deletedBanner(page).locator('button', { hasText: 'Overwrite' }).click();
}

export const editModel = (page, uri, text) =>
  page.evaluate(
    ({ u, t }) => {
      const m = window.monaco.editor
        .getModels()
        .find((x) => decodeURIComponent(x.uri.toString()).toLowerCase() === u);
      m.applyEdits([{ range: new window.monaco.Range(1, 1, 1, 1), text: t }]);
    },
    { u: uri, t: text },
  );

const BIG_LINE = `${'x'.repeat(99)}\n`;
export const BIG = BIG_LINE.repeat(25_000); // 2.5 MB — over the host's 2 MB read cap

const FILES = {
  'a.ts': 'one\ntwo\nthree\n',
  'dir/c.ts': 'one\n',
  'gone.ts': 'one\n',
  'fdel/x.ts': 'one\n',
  'fdel/y.ts': 'one\n',
  'dd.ts': 'one\n',
  'u.ts': 'one\n',
  'm.ts': 'one\n',
  'mdir/keep.txt': 'k\n',
  'r.ts': 'src\n',
  'q.ts': 'src\n',
  'qdir/q.ts': 'dest\n',
  'rdir/r.ts': 'dest\n',
  'lib.ts': 'export const lib = 1;\n',
  'use.ts': "import { lib } from './lib';\nexport const x = lib;\n",
  'big.txt': BIG,
};

export function runFileIntegrity(name, phases) {
  return runAutoSave(name, {
    files: FILES,
    phases: Object.fromEntries(
      Object.entries(phases).map(([n, run]) => [
        n,
        (ctx) => {
          phase(n);
          return run(ctx);
        },
      ]),
    ),
  });
}
