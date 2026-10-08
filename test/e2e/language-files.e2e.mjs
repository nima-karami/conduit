/**
 * Lane A of docs/specs/2026-10-08-language-support.md §7 (AC-A1…A6b, A9): Markdown / YAML / log /
 * golden files in the built app — log colours in every theme, byte-exact saves, the read-only
 * reasons, the bounded head/tail read of a 40 MB file and the tail-window toast.
 *
 * "Coloured on the first frame" is asserted the way editor-first-paint asserts it — the grammar is
 * in Monaco's registry before the editor exists — not by sampling the DOM: the harness window is
 * hidden, and a MutationObserver there saw the first view line rendered as one untokenized span
 * for every theme, ahead of any real paint.
 *
 * Run: npm run e2e -- language-files   (needs `npm run build` first)
 */

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllDocs, openDoc } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const LOG_LINE = '2026-10-08T12:00:00.123Z ERROR boom "x"';
const BIG_LINES = 1_000_000;
const TAIL_TOAST_LINE_5 = 'This log is shown from its last 2 MB — line 5 may be outside it.';
const bigLine = (i) => `line ${String(i).padStart(7, '0')} ${'.'.repeat(26)}\n`;

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-langfiles-'));
  const put = (name, body) => writeFileSync(join(root, name), body);
  put('README.md', '# Readme title\n\nSome text.\n');
  put('config.yaml', 'server:\n  port: 8080\n  tls:\n    enabled: true\nname: demo\n');
  put(
    'app.log',
    `${LOG_LINE}\n2026-10-08T12:00:01Z WARN slow 12ms\n2026-10-08T12:00:02Z INFO up\n`,
  );
  put('app.log.1', `${LOG_LINE}\n`);
  put('app.log.2026-10-01', `${LOG_LINE}\n`);
  put('expected.json.golden', '{\n  "a": 1\n}\n');
  put(
    'README.md.golden',
    [
      '# Top',
      'intro',
      '## A',
      'a body',
      '## B',
      'b body',
      '```sh',
      '# not a heading',
      '```',
      '## C',
      'c body',
      '<!-- #region notes -->',
      'r',
      '<!-- #endregion -->',
      '',
    ].join('\n'),
  );
  put('plain.golden', 'just text\n');
  put('out.txt.golden', 'one\r\ntwo\r\nthree\r\n');
  put('bom.txt', Buffer.concat([BOM, Buffer.from('alpha\nbeta\n')]));
  put('bom-idle.txt', Buffer.concat([BOM, Buffer.from('idle\r\nfile\r\n')]));
  put('mixed.txt.golden', 'a\r\nb\nc\r\n');
  put('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  put('small.txt', 'small\n');
  const chunks = [];
  for (let i = 1; i <= BIG_LINES; i++) chunks.push(bigLine(i));
  const big = chunks.join('');
  put('big.log', big);
  put('big.txt', big);
  return root;
}

async function setSettings(page, patch) {
  const cur = await page.evaluate(() => window.__settings);
  await page.evaluate((s) => window.agentDeck.post({ type: 'updateSettings', settings: s }), {
    ...cur,
    ...patch,
  });
  await page.waitForFunction(
    (p) => Object.entries(p).every(([k, v]) => window.__settings?.[k] === v),
    patch,
    { timeout: 10000 },
  );
}

/** The live, top-level editor showing `name` (not a peek). */
const editorInfo = (page, name) =>
  page.evaluate((n) => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find((e) => {
      const node = e.getDomNode();
      return (
        node?.isConnected &&
        !node.closest('.zone-widget') &&
        e.getModel()?.uri.path.endsWith(`/${n}`)
      );
    });
    const model = ed?.getModel();
    if (!model) return null;
    const visible = ed.getVisibleRanges();
    return {
      language: model.getLanguageId(),
      value: model.getValue(),
      lineCount: model.getLineCount(),
      first: model.getLineContent(1),
      lastVisible: visible.length ? visible[visible.length - 1].endLineNumber : 0,
      cursorLine: ed.getPosition()?.lineNumber ?? 0,
      readOnly: ed.getOption(window.monaco.editor.EditorOption.readOnly),
    };
  }, name);

const banners = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.viewer__banner')].map((b) => b.textContent.trim()),
  );

const toasts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.toast__msg')].map((t) => t.textContent.trim()),
  );

async function focusEditorOf(page, name) {
  await page.evaluate((n) => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find(
      (e) => e.getDomNode()?.isConnected && e.getModel()?.uri.path.endsWith(`/${n}`),
    );
    ed?.focus();
  }, name);
}

async function waitFor(fn, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(false, `timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** Rendered colour of each of `texts` on the editor line containing `marker`; null until every
 *  one is its own token span. */
const paintedColours = (page, marker, texts) =>
  page.evaluate(
    ({ marker, texts }) => {
      const line = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) =>
        l.textContent.includes(marker),
      );
      const spans = [...(line?.querySelectorAll('span span') ?? [])];
      const out = {};
      for (const t of texts) {
        const s = spans.find((x) => x.textContent.trim() === t);
        if (!s) return null;
        out[t] = getComputedStyle(s).color;
      }
      return out;
    },
    { marker, texts },
  );

/** Distinct token types the registry gives a log line right now — [''] with no grammar. */
const logTokenTypes = (page) =>
  page.evaluate((line) => {
    const tokens = window.monaco.editor.tokenize(line, 'log')[0] ?? [];
    return [...new Set(tokens.map((t) => t.type))];
  }, LOG_LINE);

const cssColour = (page, name) =>
  page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

async function foldRegions(page, name) {
  return page.evaluate(async (n) => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find(
      (e) => e.getDomNode()?.isConnected && e.getModel()?.uri.path.endsWith(`/${n}`),
    );
    const fm = await ed?.getContribution('editor.contrib.folding')?.getFoldingModel();
    if (!fm) return [];
    const out = [];
    for (let i = 0; i < fm.regions.length; i++) {
      out.push([fm.regions.getStartLineNumber(i), fm.regions.getEndLineNumber(i)]);
    }
    return out;
  }, name);
}

runScenario('language-files', async ({ app, page, log }) => {
  // ~84 MB of fixture, never left behind in the runner's temp dir, pass or fail. Removed on exit:
  // runScenario closes the app before it exits, and while the app runs the folder can't be
  // deleted (its session shell holds it as the working directory).
  const root = buildFixture();
  process.once('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.error(`[language-files] fixture not removed: ${root}: ${e?.message ?? e}`);
    }
  });
  await scenario({ app, page, log }, root);
});

async function scenario({ app, page, log }, root) {
  const at = (name) => join(root, name);
  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.evaluate(() => {
    window.__settings = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state') window.__settings = m.settings;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  await page.waitForFunction(() => !!window.__settings, null, { timeout: 10000 });

  // AC-A1 — Markdown renders; YAML colours and folds.
  await app.evaluate(
    (electron, { path, sid }) => {
      electron.BrowserWindow.getAllWindows()[0]?.webContents.send('to-webview', {
        type: 'openFileInEditor',
        path,
        sessionId: sid,
      });
    },
    { path: at('README.md').replace(/\\/g, '/'), sid },
  );
  await page.waitForFunction(
    () => document.querySelector('.markdown h1')?.textContent.includes('Readme title'),
    null,
    { timeout: 20000 },
  );
  log('AC-A1 README.md rendered');
  await openDoc(app, page, sid, at('config.yaml'));
  const yaml = await editorInfo(page, 'config.yaml');
  assert(yaml?.language === 'yaml', `config.yaml language ${yaml?.language}`);
  const yamlClasses = await waitFor(
    () =>
      page.evaluate(() => {
        const line = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) =>
          l.textContent.startsWith('server:'),
        );
        const cls = new Set(
          [...(line?.querySelectorAll('span span') ?? [])].map((s) => s.className),
        );
        return cls.size > 1 || (cls.size === 1 && ![...cls][0].includes('mtk1')) ? [...cls] : null;
      }),
    'a coloured YAML line 1',
  );
  log(`config.yaml line 1 classes ${JSON.stringify(yamlClasses)}`);
  const yamlFolds = await waitFor(async () => {
    const r = await foldRegions(page, 'config.yaml');
    return r.some(([s]) => s === 1) ? r : null;
  }, 'a fold on the nested YAML map');
  log(`config.yaml folds ${JSON.stringify(yamlFolds)}`);

  // AC-A2 — log language for plain and rotated logs; the grammar is registered before the first
  // log editor exists; level, timestamp and string paint in their tokens' colours in every theme.
  const before = await logTokenTypes(page);
  assert(before.length <= 1, `log grammar registered before any log was opened: ${before}`);
  for (const name of ['app.log.1', 'app.log.2026-10-01']) {
    await openDoc(app, page, sid, at(name));
    const info = await editorInfo(page, name);
    assert(info?.language === 'log', `${name} language ${info?.language}`);
  }
  const after = await logTokenTypes(page);
  log(
    `log token types before/after the first open: ${JSON.stringify(before)} / ${JSON.stringify(after)}`,
  );
  for (const t of ['number.log', 'log-error.log', 'string.log']) {
    assert(after.includes(t), `log grammar missing ${t} on open: ${JSON.stringify(after)}`);
  }
  const SAMPLE = ['2026-10-08T12:00:00.123Z', 'ERROR', '"x"'];
  for (const theme of ['aero', 'aero-dark', 'neon']) {
    await setSettings(page, { theme });
    await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
    await closeAllDocs(page);
    await openDoc(app, page, sid, at('app.log'));
    const want = {
      '2026-10-08T12:00:00.123Z': await cssColour(page, '--syn-number'),
      ERROR: await cssColour(page, '--syn-error'),
      '"x"': await cssColour(page, '--syn-string'),
    };
    let painted = null;
    await waitFor(
      async () => {
        painted = await paintedColours(page, 'boom', SAMPLE);
        return painted && SAMPLE.every((t) => painted[t] === want[t]);
      },
      `${theme} log colours ${JSON.stringify(want)}`,
    );
    log(`${theme} painted ${JSON.stringify(painted)}`);
  }
  await setSettings(page, { theme: 'aero-dark' });

  // AC-A3 — goldens colour as what they wrap and always open as source.
  await closeAllDocs(page);
  for (const [name, lang] of [
    ['expected.json.golden', 'json'],
    ['README.md.golden', 'markdown'],
    ['plain.golden', 'plaintext'],
  ]) {
    await openDoc(app, page, sid, at(name));
    const info = await editorInfo(page, name);
    assert(info?.language === lang, `${name} language ${info?.language}, want ${lang}`);
  }
  const rendered = await page.evaluate(() => !!document.querySelector('.markdown h1'));
  assert(!rendered, 'README.md.golden must not render as Markdown');

  // AC-A9 — Markdown source folds by heading; a # in a fence isn't a heading; fences and
  // regions still fold.
  await openDoc(app, page, sid, at('README.md.golden'));
  const mdFolds = await waitFor(async () => {
    const r = await foldRegions(page, 'README.md.golden');
    return r.length ? r : null;
  }, 'markdown folds');
  log(`README.md.golden folds ${JSON.stringify(mdFolds)}`);
  const has = (s, e) => mdFolds.some(([a, b]) => a === s && b === e);
  assert(has(5, 9), '## B should fold lines 5–9');
  assert(has(7, 9), 'the fence should fold 7–9');
  assert(has(12, 14), 'the region should fold 12–14');
  assert(!mdFolds.some(([s]) => s === 8), 'a # inside a fence is not a fold start');

  // AC-A4b — a BOM file opened and left alone is clean and never written (auto-save on).
  await setSettings(page, { autoSave: 'afterDelay', autoSaveDelay: 300 });
  const idleBefore = statSync(at('bom-idle.txt')).mtimeMs;
  await openDoc(app, page, sid, at('bom-idle.txt'));
  await page.waitForTimeout(1500);
  const idleDirty = await page.evaluate(() => !!document.querySelector('.tab__dirty'));
  await closeAllDocs(page);
  await page.waitForTimeout(800);
  assert(!idleDirty, 'an untouched BOM file must not be dirty');
  assert(statSync(at('bom-idle.txt')).mtimeMs === idleBefore, 'an untouched BOM file was written');

  // AC-A4 — edits to a CRLF golden and a BOM file save byte-exact.
  for (const name of ['out.txt.golden', 'bom.txt']) {
    const before = readFileSync(at(name));
    await openDoc(app, page, sid, at(name));
    await focusEditorOf(page, name);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('q');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');
    await page.keyboard.press('Control+s');
    const want = Buffer.concat([before, Buffer.from('x')]);
    await waitFor(() => readFileSync(at(name)).equals(want), `${name} saved as original + x`);
    log(`AC-A4 ${name} saved byte-exact`);
  }
  await setSettings(page, { autoSave: 'off' });

  // AC-A5 — mixed-EOL golden and invalid UTF-8 are read-only with their banners.
  for (const [name, banner] of [
    ['mixed.txt.golden', 'Mixed line endings — read-only so this golden file stays byte-exact.'],
    ['latin1.txt', "Not valid UTF-8 — read-only so saving can't change its bytes."],
  ]) {
    const before = readFileSync(at(name));
    await openDoc(app, page, sid, at(name));
    const shown = await banners(page);
    assert(shown.includes(banner), `${name} banner: ${JSON.stringify(shown)}`);
    const valueBefore = (await editorInfo(page, name)).value;
    await focusEditorOf(page, name);
    await page.keyboard.type('zz');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(600);
    const info = await editorInfo(page, name);
    assert(info.readOnly === true, `${name} should be read-only`);
    assert(info.value === valueBefore, `${name} accepted typing`);
    assert(readFileSync(at(name)).equals(before), `${name} changed on disk`);
  }

  // AC-A6 — 40 MB: a log shows its tail from a whole line, a text file its head.
  await closeAllDocs(page);
  await openDoc(app, page, sid, at('big.txt'));
  const head = await editorInfo(page, 'big.txt');
  assert(head.first === bigLine(1).trimEnd(), `big.txt first line ${head.first}`);
  assert(
    (await banners(page)).includes('Large file — showing the first 2 MB, read-only.'),
    'big.txt head banner',
  );
  await openDoc(app, page, sid, at('big.log'));
  const tail = await editorInfo(page, 'big.log');
  const lastLine = bigLine(BIG_LINES).trimEnd();
  const lines = tail.value.split('\n');
  assert(lines[lines.length - 2] === lastLine, `big.log last line ${lines[lines.length - 2]}`);
  assert(/^line \d{7} \.{26}$/.test(tail.first), `big.log first line is partial: ${tail.first}`);
  assert(
    (await banners(page)).includes('Large log — showing the last 2 MB, read-only.'),
    'big.log tail banner',
  );
  assert(
    tail.lastVisible >= tail.lineCount - 1,
    `big.log not opened at its end: ${JSON.stringify(tail.lastVisible)}`,
  );
  // AC-A6b — a navigation addressed to line 5 of the tail window toasts and shows the END, never
  // line 5. Content search skips files over 1 MB and terminal links are canvas-bound, so the line-5
  // reveal is staged by nav history: leave big.log from line 5, then go Back. Back is the same
  // setReveal → takeReveal route a search hit or a terminal link takes.
  await focusEditorOf(page, 'big.log');
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await waitFor(
    async () => (await editorInfo(page, 'big.log'))?.cursorLine === 5,
    'the cursor on line 5',
  );
  await openDoc(app, page, sid, at('small.txt'));
  await focusEditorOf(page, 'small.txt');
  await page.keyboard.press('Alt+ArrowLeft');
  const toast = await waitFor(
    async () => (await toasts(page)).find((t) => t === TAIL_TOAST_LINE_5),
    'the tail-window toast for line 5',
  );
  log(`AC-A6b toast: ${toast}`);
  const back = await waitFor(async () => {
    const info = await editorInfo(page, 'big.log');
    return info?.cursorLine === info?.lineCount ? info : null;
  }, 'the cursor on the last line after the line-5 reveal');
  assert(back.cursorLine !== 5, 'the tail window revealed line 5 as if it were the file line');
  assert(back.lastVisible >= back.lineCount - 1, `end not in view: ${back.lastVisible}`);

  let appended = '';
  for (let i = 1; i <= 100; i++) appended += bigLine(BIG_LINES + i);
  appendFileSync(at('big.log'), appended);
  const newLast = bigLine(BIG_LINES + 100).trimEnd();
  const grown = await waitFor(async () => {
    const info = await editorInfo(page, 'big.log');
    const ls = info?.value.split('\n') ?? [];
    return ls[ls.length - 2] === newLast ? info : null;
  }, 'the appended lines');
  assert(
    grown.lastVisible >= grown.lineCount - 1,
    `after append the last line left the view: ${grown.lastVisible}/${grown.lineCount}`,
  );
  log('AC-A6b append kept the end in view');
}
