/**
 * Lane A of docs/specs/2026-10-08-language-coverage.md §7 (AC-A1…A6): every §2.2 row opens with
 * its language and paints, shebang files resolve by content, the TOML / diff grammars run through
 * Monaco's own Monarch, and Review colours a changed Makefile and Cargo.toml.
 *
 * "Coloured on the first frame" is asserted on the model's own line tokens inside
 * `onDidCreateModel`, which only colour when the grammar was registered synchronously before the
 * editor was built (editor-first-paint's reasoning; the hidden harness window paints too late to
 * sample). JSON is the one exception by design — its tokens come from its own language service.
 *
 * Run: npm run e2e -- language-coverage   (needs `npm run build` first)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitBase } from './changes-fixture.mjs';
import { assert, openReview, openSession, runScenario } from './harness.mjs';

/** [file name, language id, content]. One fixture per §2.2 table row and alias. */
const ROWS = [
  ['stub.pyi', 'python', 'def f(x: int) -> int: ...\n'],
  ['gui.pyw', 'python', 'import tkinter\n'],
  ['vec.hxx', 'cpp', '#include <vector>\n'],
  ['impl.ipp', 'cpp', 'int f() { return 0; }\n'],
  ['kernel.cu', 'cpp', '__global__ void k() { int x = 0; }\n'],
  ['sketch.ino', 'cpp', 'void setup() { int x = 1; }\n'],
  ['view.mm', 'objective-c', '@interface Foo : NSObject\n@end\n'],
  ['script.csx', 'csharp', 'using System;\n'],
  ['build.cake', 'csharp', 'var target = "Default";\n'],
  ['page.cshtml', 'razor', '<div class="a">hi</div>\n'],
  ['comp.razor', 'razor', '<p class="b">x</p>\n'],
  ['sig.fsi', 'fsharp', 'let x = 1\n'],
  ['run.fsscript', 'fsharp', 'let y = "s"\n'],
  ['main.ml', 'ocaml', 'let x = 1\n'],
  ['main.mli', 'ocaml', 'val x : int\n'],
  ['tasks.rake', 'ruby', 'task :default do\nend\n'],
  ['lib.gemspec', 'ruby', 'Gem::Specification.new do |s|\nend\n'],
  ['config.ru', 'ruby', 'run "app"\n'],
  ['Gemfile', 'ruby', 'source "https://rubygems.org"\n'],
  ['Rakefile', 'ruby', 'require "rake"\n'],
  ['Podfile', 'ruby', 'platform :ios, "15.0"\n'],
  ['Vagrantfile', 'ruby', 'Vagrant.configure("2") do |c|\nend\n'],
  ['Brewfile', 'ruby', 'brew "git"\n'],
  ['Manifest.psd1', 'powershell', "@{ ModuleVersion = '1.0' }\n"],
  ['view.phtml', 'php', '<?php echo "x"; ?>\n'],
  ['page.xhtml', 'html', '<html><body></body></html>\n'],
  ['page.shtml', 'html', '<div class="x"></div>\n'],
  ['app.csproj', 'xml', '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n'],
  ['schema.xsd', 'xml', '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>\n'],
  ['web.config', 'xml', '<configuration a="1"/>\n'],
  ['data.json5', 'json', '{ "a": 1 }\n'],
  ['lines.jsonl', 'json', '{"k": "v"}\n{"k": "w"}\n'],
  ['stream.ndjson', 'json', '{"k": 1}\n'],
  ['.babelrc', 'json', '// presets\n{ "presets": [] }\n'],
  ['.eslintrc', 'json', '{ "root": true }\n'],
  ['tsconfig.json', 'json', '// strict\n{ "compilerOptions": { "strict": true } }\n'],
  ['shared.cljc', 'clojure', '(defn f [x] x)\n'],
  ['data.edn', 'clojure', '{:a 1}\n'],
  ['build.sbt', 'scala', 'val x = 1\n'],
  ['env.ksh', 'shell', 'echo "hi"\n'],
  ['.zprofile', 'shell', 'export PATH="$HOME/bin:$PATH"\n'],
  ['.envrc', 'shell', 'export A="1"\n'],
  ['PKGBUILD', 'shell', '# Maintainer: x\npkgname=foo\n'],
  ['.editorconfig', 'ini', '[*]\nindent_style = space\n'],
  ['.gitattributes', 'ini', '# attrs\n* text=auto\n'],
  ['Cargo.toml', 'toml', '[package]\nname = "demo"\n'],
  ['Cargo.lock', 'toml', '# This file is generated\nversion = 3\n'],
  ['Pipfile', 'toml', '[packages]\nrequests = "*"\n'],
  ['Makefile.toml', 'toml', '[tasks.build]\ncommand = "cargo"\n'],
  ['Makefile', 'makefile', 'all: build\n\tcc -o x $(SRC)\n'],
  ['GNUmakefile', 'makefile', 'CC := gcc\n'],
  ['rules.mk', 'makefile', '# rules\nX = 1\n'],
  ['CMakeLists.txt', 'cmake', 'cmake_minimum_required(VERSION 3.20)\n'],
  ['toolchain.cmake', 'cmake', 'set(CMAKE_SYSTEM_NAME Linux)\n'],
  ['fix.diff', 'diff', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'],
  ['x.rej', 'diff', '@@ -1 +1 @@\n-a\n+b\n'],
  ['.gitignore', 'ignore', '# deps\nnode_modules/\n'],
  ['.dockerignore', 'ignore', '*.log\n'],
  ['.env', 'dotenv', 'KEY=value\n'],
  ['.env.local', 'dotenv', 'TOKEN=abc\n'],
  ['.env.json', 'json', '{ "a": 1 }\n'],
  ['prod.env', 'dotenv', 'PORT=8080\n'],
  ['lib.groovy', 'groovy', 'def x = "y"\n'],
  ['build.gradle', 'groovy', 'apply plugin: "java"\n'],
  ['Jenkinsfile', 'groovy', '// pipeline\npipeline { }\n'],
  ['Dockerfile.dev', 'dockerfile', 'FROM node:20\n'],
  ['app.coffee', 'coffeescript', 'x = "a"\n'],
  ['view.hbs', 'handlebars', '<div>{{name}}</div>\n'],
  ['page.twig', 'twig', '{{ name }}\n'],
  ['page.pug', 'pug', 'div.a hello\n'],
  ['page.liquid', 'liquid', '{{ x }}\n'],
  ['main.bicep', 'bicep', 'param x string\n'],
  ['shader.wgsl', 'wgsl', 'fn main() {}\n'],
  ['lib.scm', 'scheme', '(define x 1)\n'],
  ['lib.rkt', 'scheme', '(define y 2)\n'],
  ['README.rst', 'restructuredtext', '- a bullet\n'],
  ['top.sv', 'systemverilog', 'module m; endmodule\n'],
  ['top.v', 'verilog', 'module n; endmodule\n'],
  ['main.tsp', 'typespec', 'model Pet { name: string; }\n'],
  ['q.cypher', 'cypher', 'MATCH (n) RETURN n\n'],
  ['q.pq', 'powerquery', 'let x = 1 in x\n'],
  ['op.qs', 'qsharp', 'namespace Q { }\n'],
  ['q.rq', 'sparql', 'SELECT ?s WHERE { ?s ?p ?o }\n'],
];

/** AC-A2: [file name, language id, content] resolved by content, not name. */
const SHEBANG_ROWS = [
  ['bin/py', 'python', '#!/usr/bin/env python3\nprint(1)\n'],
  ['bin/d', 'typescript', '#!/usr/bin/env -S deno run\nconsole.log(1);\n'],
  ['bin/s', 'shell', '#!/bin/bash\r\necho hi\r\n'],
  ['bin/none', 'plaintext', 'just text\n'],
  ['LICENSE', 'plaintext', 'MIT License\n'],
  ['go.sum', 'plaintext', 'example.com/x v1.0.0 h1:abc=\n'],
];

const TOML_SAMPLE = ['[[bin]]', 'a.b-c = 1 # x', 's = """', 'body', 'end"""'].join('\n');
const PATCH = [
  'diff --git a/x b/x',
  '--- a/x',
  '+++ b/x',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  ' ctx',
  '@@ -9,2 +9,2 @@',
  '-gone',
  '+here',
  '',
].join('\n');

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-langcov-'));
  const put = (name, body) => writeFileSync(join(root, name), body);
  mkdirSync(join(root, 'bin'));
  for (const [name, , body] of [...ROWS, ...SHEBANG_ROWS]) put(name, body);
  return root;
}

async function waitFor(fn, what, timeout = 15000, every = 100) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  assert(false, `timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
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

/** The model language of the live, top-level editor showing `name`, and its first non-blank line. */
const modelOf = (page, name) =>
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
    const first = model.getLinesContent().find((l) => l.trim() !== '') ?? '';
    return { language: model.getLanguageId(), first };
  }, name);

/** Token types Monaco's registry gives `text` in `language` right now, per line. */
const tokenTypes = (page, text, language) =>
  page.evaluate(
    ({ t, l }) => window.monaco.editor.tokenize(t, l).map((line) => line.map((x) => x.type)),
    { t: text, l: language },
  );

/** `{offset, type}` per line for the opened file's whole text, state carried line to line. */
const fileTokens = (page, name) =>
  page.evaluate((n) => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith(`/${n}`));
    if (!model) return [];
    return window.monaco.editor
      .tokenize(model.getValue(), model.getLanguageId())
      .map((line) => line.map(({ offset, type }) => ({ offset, type })));
  }, name);

/** Monaco's `StandardTokenType.Comment`. */
const STANDARD_COMMENT = 1;

/** The opened model's own tokens on `line`: text, class and standard token type. */
const modelLineTokens = (page, name, line) =>
  page.evaluate(
    ({ n, l }) => {
      const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith(`/${n}`));
      if (!model) return null;
      model.tokenization.forceTokenization(l);
      const tokens = model.tokenization.getLineTokens(l);
      const text = model.getLineContent(l);
      return Array.from({ length: tokens.getCount() }, (_, i) => ({
        text: text.slice(tokens.getStartOffset(i), tokens.getEndOffset(i)),
        cls: tokens.getClassName(i),
        standard: tokens.getStandardTokenType(i),
      }));
    },
    { n: name, l: line },
  );

/**
 * The classes `name`'s first non-blank line had inside `onDidCreateModel` — synchronously, before
 * a lazily-loaded grammar could resolve — so only a grammar registered up front colours here.
 * Reading later can't tell: Monaco's async factory resolves from the bundle within a turn.
 */
const atCreation = (page, name) =>
  page.evaluate(
    (n) =>
      Object.entries(window.__atCreation ?? {}).find(([path]) => path.endsWith(`/${n}`))?.[1] ??
      null,
    name,
  );

/**
 * goto-matrix's `openDoc`, polled from node: its `waitForFunction` polls on rAF, which the hidden
 * harness window throttles to seconds per open — over ~90 rows that alone overran the deadline.
 */
async function open(app, page, sid, absPath, name) {
  await app.evaluate(
    (electron, { path, sid }) => {
      electron.BrowserWindow.getAllWindows()[0]?.webContents.send('to-webview', {
        type: 'openFileInEditor',
        path,
        sessionId: sid,
      });
    },
    { path: absPath.replace(/\\/g, '/'), sid },
  );
  return waitFor(() => modelOf(page, name), `${name} open`, 10000, 50);
}

/** A rendered span class list carries a colour other than the default foreground (`mtk1`). */
const paintsColour = (classes) =>
  classes.some((c) => c.split(' ').some((k) => /^mtk\d+$/.test(k) && k !== 'mtk1'));

/**
 * The `mtk*` classes the view would paint on `name`'s first non-blank line, read from the model's
 * own line tokens — the source the renderer draws from. The hidden harness window paints on a
 * throttled frame clock, so sampling the DOM per row both lags and can't tell a first frame.
 */
const lineClasses = (page, name) =>
  page.evaluate((n) => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find(
      (e) => e.getDomNode()?.isConnected && e.getModel()?.uri.path.endsWith(`/${n}`),
    );
    const model = ed?.getModel();
    if (!model) return null;
    const line = model.getLinesContent().findIndex((l) => l.trim() !== '') + 1;
    model.tokenization.forceTokenization(line);
    const tokens = model.tokenization.getLineTokens(line);
    const out = new Set();
    for (let i = 0; i < tokens.getCount(); i++) out.add(tokens.getClassName(i));
    return [...out];
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

const cssColour = (page, name) =>
  page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

/** Rendered colour of the span reading `text` on the view line containing `marker`. */
const spanColour = (page, marker, text) =>
  page.evaluate(
    ({ marker, text }) => {
      const line = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) =>
        l.textContent.includes(marker),
      );
      const s = [...(line?.querySelectorAll('span span') ?? [])].find(
        (x) => x.textContent.trim() === text,
      );
      return s ? getComputedStyle(s).color : null;
    },
    { marker, text },
  );

runScenario('language-coverage', async ({ app, page, log }) => {
  const root = buildFixture();
  process.once('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.error(`[language-coverage] fixture not removed: ${root}: ${e?.message ?? e}`);
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
  await setSettings(page, { theme: 'neon' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'neon');
  await page.evaluate(() => {
    window.__atCreation = {};
    window.monaco.editor.onDidCreateModel((model) => {
      const line = model.getLinesContent().findIndex((l) => l.trim() !== '') + 1;
      if (line === 0) return;
      model.tokenization.forceTokenization(line);
      const tokens = model.tokenization.getLineTokens(line);
      const classes = new Set();
      for (let i = 0; i < tokens.getCount(); i++) classes.add(tokens.getClassName(i));
      window.__atCreation[model.uri.path] = [...classes];
    });
  });

  // AC-A1 — every row: its language, coloured by the registry the moment the model exists, and
  // a non-default token class painted on its first non-blank line.
  const failures = [];
  const t0 = Date.now();
  for (let i = 0; i < ROWS.length; i++) {
    const [name, lang] = ROWS[i];
    const info = await open(app, page, sid, at(name), name);
    if (info?.language !== lang) {
      failures.push(`${name}: language ${info?.language}, want ${lang}`);
      continue;
    }
    // JSON's tokens arrive from its language service a turn later; every Monarch grammar must
    // colour the model at the moment it is created.
    const classes =
      lang === 'json'
        ? await waitFor(
            async () => {
              const c = await lineClasses(page, name);
              return c && paintsColour(c) ? c : null;
            },
            `${name} coloured`,
            5000,
          ).catch(() => null)
        : await atCreation(page, name);
    if (!classes || !paintsColour(classes)) {
      failures.push(`${name}: line classes ${JSON.stringify(classes)}`);
    } else log(`${name} → ${lang} ${JSON.stringify(classes)} at ${Date.now() - t0}ms`);
  }
  assert(failures.length === 0, `AC-A1 rows failed:\n  ${failures.join('\n  ')}`);

  // AC-A2 — shebang files resolve by content; names with no rule and go.sum stay plain.
  for (const [name, lang] of SHEBANG_ROWS) {
    await open(app, page, sid, at(name), name);
    const info = await waitFor(async () => {
      const m = await modelOf(page, name);
      return m?.language === lang ? m : null;
    }, `${name} as ${lang}`);
    log(`AC-A2 ${name} → ${info.language}`);
  }

  // AC-A3 — TOML through Monaco's own Monarch.
  const toml = await tokenTypes(page, TOML_SAMPLE, 'toml');
  log(`AC-A3 toml ${JSON.stringify(toml)}`);
  assert(
    JSON.stringify(toml[0]) === JSON.stringify(['type.toml']),
    `[[bin]] is one type token: ${JSON.stringify(toml[0])}`,
  );
  for (const t of ['keyword.toml', 'number.toml', 'comment.toml']) {
    assert(toml[1].includes(t), `a.b-c = 1 # x lacks ${t}: ${JSON.stringify(toml[1])}`);
  }
  assert(toml[2].includes('string.toml'), `""" opens a string: ${JSON.stringify(toml[2])}`);
  for (const i of [3, 4]) {
    assert(
      toml[i].every((t) => t === 'string.toml'),
      `line ${i + 1} of the """ string: ${JSON.stringify(toml[i])}`,
    );
  }

  // AC-A4 — a patch: + string, - log-error, @@ type; one fold per hunk.
  writeFileSync(at('x.patch'), PATCH);
  await open(app, page, sid, at('x.patch'), 'x.patch');
  const patch = await fileTokens(page, 'x.patch');
  log(`AC-A4 patch ${JSON.stringify(patch)}`);
  const header = PATCH.split('\n')[3];
  for (const i of [3, 7]) {
    const inHeader = patch[i].filter((t) => t.offset < header.length);
    assert(
      inHeader.length === 1 && inHeader[0].offset === 0 && inHeader[0].type === 'type.diff',
      `@@ header line ${i + 1} must be one type token: ${JSON.stringify(patch[i])}`,
    );
  }
  assert(patch[4][0].type === 'log-error.diff', `- line: ${JSON.stringify(patch[4])}`);
  assert(patch[5][0].type === 'string.diff', `+ line: ${JSON.stringify(patch[5])}`);
  const folds = await waitFor(async () => {
    const r = await foldRegions(page, 'x.patch');
    return r.length >= 3 ? r : null;
  }, 'x.patch folds');
  log(`AC-A4 folds ${JSON.stringify(folds)}`);
  // PATCH ends in a newline, so the model's last line (11) is the empty one after it.
  for (const [s, e] of [
    [1, 11],
    [4, 7],
    [8, 11],
  ]) {
    assert(
      folds.some(([a, b]) => a === s && b === e),
      `fold ${s}–${e} missing: ${JSON.stringify(folds)}`,
    );
  }

  // AC-A6 — the `//` line of the opened tsconfig.json / .babelrc is a comment in the model's own
  // tokens; every line of the opened .jsonl colours its keys and string values.
  for (const name of ['tsconfig.json', '.babelrc']) {
    await open(app, page, sid, at(name), name);
    const std = await waitFor(async () => {
      const t = await modelLineTokens(page, name, 1);
      return t?.some((x) => x.standard === STANDARD_COMMENT && x.text.startsWith('//')) ? t : null;
    }, `${name} line 1 comment token`);
    log(`AC-A6 ${name} ${JSON.stringify(std)}`);
  }
  await open(app, page, sid, at('lines.jsonl'), 'lines.jsonl');
  const jsonl = await waitFor(async () => {
    const lines = await fileTokens(page, 'lines.jsonl');
    const ok = lines
      .slice(0, 2)
      .every(
        (l) =>
          l.some((t) => t.type.startsWith('string.key')) &&
          l.some((t) => t.type.startsWith('string.value')),
      );
    return ok ? lines : null;
  }, 'lines.jsonl keys and values on lines 1 and 2');
  log(`AC-A6 jsonl ${JSON.stringify(jsonl.slice(0, 2))}`);

  // The grammars use only existing themed tokens: TOML paints in each theme's own colours.
  for (const theme of ['aero', 'aero-dark', 'neon']) {
    await setSettings(page, { theme });
    await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
    await open(app, page, sid, at('Cargo.toml'), 'Cargo.toml');
    const want = {
      table: await cssColour(page, '--syn-type'),
      key: await cssColour(page, '--syn-keyword'),
    };
    // Bracket-pair colourisation paints the header's `[` `]` itself, so the table's own colour is
    // read off its name.
    const painted = async () => ({
      table: await spanColour(page, '[package]', 'package'),
      key: await spanColour(page, 'demo', 'name'),
    });
    const same = (got) => got.table === want.table && got.key === want.key;
    const got = await waitFor(
      async () => {
        const g = await painted();
        return same(g) ? g : null;
      },
      `${theme} TOML colours ${JSON.stringify(want)}`,
    ).catch(async () => painted());
    assert(same(got), `${theme} TOML painted ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    log(`${theme} TOML painted ${JSON.stringify(want)}`);
  }

  // AC-A5 — Review colours a changed Makefile and Cargo.toml.
  commitBase(root);
  writeFileSync(at('Makefile'), 'all: build test\n\tcc -o x $(SRC) "y"\n');
  writeFileSync(at('Cargo.toml'), '[package]\nname = "demo2"\nversion = "0.1.0"\n');
  await openReview(page);
  for (const path of ['Makefile', 'Cargo.toml']) {
    const spans = await waitFor(
      () =>
        page.evaluate((p) => {
          const card = document.querySelector(`.review .rcard[data-path="${p}"]`);
          if (!card?.querySelector('.rline')) return 0;
          return card.querySelectorAll('.rline__text span[class*="hljs-"]').length;
        }, path),
      `${path} Review rows with hljs spans`,
      20000,
    );
    log(`AC-A5 ${path}: ${spans} hljs spans`);
  }
}
