/**
 * Register a language's tokenizer SYNCHRONOUSLY, before the editor is created.
 *
 * Monaco wires every basic language behind `registerTokensProviderFactory` with an async
 * `create()` that does a dynamic `import()` (basic-languages/_.contribution.js). The first
 * paint of a freshly-opened file is therefore always null-tokenized — plain white text —
 * and only repaints once that promise resolves, which stretches into a visible flash
 * whenever the main thread is busy. In an esbuild iife bundle every one of those grammar
 * modules is already inlined, so the laziness buys nothing and costs an unstyled frame.
 *
 * Importing them statically and registering up front adds ZERO bytes (they were in the
 * bundle either way) and removes the flash: an explicit registration supersedes the lazy
 * factory in Monaco's tokenization registry.
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3f.
 */

import * as monaco from 'monaco-editor';
import * as bat from 'monaco-editor/esm/vs/basic-languages/bat/bat.js';
import * as bicep from 'monaco-editor/esm/vs/basic-languages/bicep/bicep.js';
import * as clojure from 'monaco-editor/esm/vs/basic-languages/clojure/clojure.js';
import * as coffee from 'monaco-editor/esm/vs/basic-languages/coffee/coffee.js';
import * as cpp from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import * as csharp from 'monaco-editor/esm/vs/basic-languages/csharp/csharp.js';
import * as css from 'monaco-editor/esm/vs/basic-languages/css/css.js';
import * as cypher from 'monaco-editor/esm/vs/basic-languages/cypher/cypher.js';
import * as dart from 'monaco-editor/esm/vs/basic-languages/dart/dart.js';
import * as dockerfile from 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.js';
import * as elixir from 'monaco-editor/esm/vs/basic-languages/elixir/elixir.js';
import * as fsharp from 'monaco-editor/esm/vs/basic-languages/fsharp/fsharp.js';
import * as go from 'monaco-editor/esm/vs/basic-languages/go/go.js';
import * as graphql from 'monaco-editor/esm/vs/basic-languages/graphql/graphql.js';
import * as handlebars from 'monaco-editor/esm/vs/basic-languages/handlebars/handlebars.js';
import * as hcl from 'monaco-editor/esm/vs/basic-languages/hcl/hcl.js';
import * as html from 'monaco-editor/esm/vs/basic-languages/html/html.js';
import * as ini from 'monaco-editor/esm/vs/basic-languages/ini/ini.js';
import * as java from 'monaco-editor/esm/vs/basic-languages/java/java.js';
import * as julia from 'monaco-editor/esm/vs/basic-languages/julia/julia.js';
import * as kotlin from 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js';
import * as less from 'monaco-editor/esm/vs/basic-languages/less/less.js';
import * as liquid from 'monaco-editor/esm/vs/basic-languages/liquid/liquid.js';
import * as lua from 'monaco-editor/esm/vs/basic-languages/lua/lua.js';
import * as markdown from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js';
import * as mdx from 'monaco-editor/esm/vs/basic-languages/mdx/mdx.js';
import * as objectiveC from 'monaco-editor/esm/vs/basic-languages/objective-c/objective-c.js';
import * as pascal from 'monaco-editor/esm/vs/basic-languages/pascal/pascal.js';
import * as perl from 'monaco-editor/esm/vs/basic-languages/perl/perl.js';
import * as php from 'monaco-editor/esm/vs/basic-languages/php/php.js';
import * as powerquery from 'monaco-editor/esm/vs/basic-languages/powerquery/powerquery.js';
import * as powershell from 'monaco-editor/esm/vs/basic-languages/powershell/powershell.js';
import * as protobuf from 'monaco-editor/esm/vs/basic-languages/protobuf/protobuf.js';
import * as pug from 'monaco-editor/esm/vs/basic-languages/pug/pug.js';
import * as python from 'monaco-editor/esm/vs/basic-languages/python/python.js';
import * as qsharp from 'monaco-editor/esm/vs/basic-languages/qsharp/qsharp.js';
import * as r from 'monaco-editor/esm/vs/basic-languages/r/r.js';
import * as razor from 'monaco-editor/esm/vs/basic-languages/razor/razor.js';
import * as restructuredtext from 'monaco-editor/esm/vs/basic-languages/restructuredtext/restructuredtext.js';
import * as ruby from 'monaco-editor/esm/vs/basic-languages/ruby/ruby.js';
import * as rust from 'monaco-editor/esm/vs/basic-languages/rust/rust.js';
import * as scala from 'monaco-editor/esm/vs/basic-languages/scala/scala.js';
import * as scheme from 'monaco-editor/esm/vs/basic-languages/scheme/scheme.js';
import * as scss from 'monaco-editor/esm/vs/basic-languages/scss/scss.js';
import * as shell from 'monaco-editor/esm/vs/basic-languages/shell/shell.js';
import * as solidity from 'monaco-editor/esm/vs/basic-languages/solidity/solidity.js';
import * as sparql from 'monaco-editor/esm/vs/basic-languages/sparql/sparql.js';
import * as sql from 'monaco-editor/esm/vs/basic-languages/sql/sql.js';
import * as swift from 'monaco-editor/esm/vs/basic-languages/swift/swift.js';
import * as systemverilog from 'monaco-editor/esm/vs/basic-languages/systemverilog/systemverilog.js';
import * as tcl from 'monaco-editor/esm/vs/basic-languages/tcl/tcl.js';
import * as twig from 'monaco-editor/esm/vs/basic-languages/twig/twig.js';
import * as typescript from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';
import * as typespec from 'monaco-editor/esm/vs/basic-languages/typespec/typespec.js';
import * as vb from 'monaco-editor/esm/vs/basic-languages/vb/vb.js';
import * as wgsl from 'monaco-editor/esm/vs/basic-languages/wgsl/wgsl.js';
import * as xml from 'monaco-editor/esm/vs/basic-languages/xml/xml.js';
import * as yaml from 'monaco-editor/esm/vs/basic-languages/yaml/yaml.js';
import { cmake } from './cmake-grammar';
import { diffFoldingRanges } from './diff-folding';
import { diff } from './diff-grammar';
import { type Grammar, gomod } from './gomod-grammar';
import { groovy } from './groovy-grammar';
import { ignore } from './ignore-grammar';
import { log } from './log-grammar';
import { makefile } from './makefile-grammar';
import { markdownFoldingRanges } from './markdown-folding';
import { toml } from './toml-grammar';

/**
 * Keyed by the language ids `src/lang.ts` produces, so every extension the app maps to a
 * language paints on the first frame. JS shares Monaco's TypeScript grammar (it covers JSX
 * and plain JS), and C shares C++'s — the same pairing Monaco's own contributions use.
 * Verilog shares SystemVerilog's for the same reason (`systemverilog.contribution.js`).
 */
const GRAMMARS: Record<string, Grammar> = {
  bat,
  bicep,
  c: cpp,
  clojure,
  cmake,
  coffeescript: coffee,
  cpp,
  csharp,
  css,
  cypher,
  dart,
  diff,
  dockerfile,
  dotenv: ini,
  elixir,
  fsharp,
  go,
  gomod,
  graphql,
  groovy,
  handlebars,
  hcl,
  html,
  ignore,
  ini,
  java,
  javascript: typescript,
  julia,
  kotlin,
  less,
  liquid,
  log,
  lua,
  makefile,
  markdown,
  mdx,
  'objective-c': objectiveC,
  ocaml: fsharp,
  pascal,
  perl,
  php,
  powerquery,
  powershell,
  proto: protobuf,
  pug,
  python,
  qsharp,
  r,
  razor,
  restructuredtext,
  ruby,
  rust,
  scala,
  scheme,
  scss,
  shell,
  sol: solidity,
  sparql,
  sql,
  swift,
  systemverilog,
  tcl,
  toml,
  twig,
  typescript,
  typespec,
  vb,
  verilog: systemverilog,
  wgsl,
  xml,
  yaml,
};

// Monaco refuses a tokenizer for an id it doesn't know, and unlike every id above no
// contribution declares these.
for (const id of [
  'gomod',
  'log',
  'dotenv',
  'groovy',
  'ocaml',
  'toml',
  'diff',
  'makefile',
  'cmake',
  'ignore',
]) {
  monaco.languages.register({ id });
}

monaco.languages.registerFoldingRangeProvider('diff', {
  provideFoldingRanges: (model) => diffFoldingRanges(model.getLinesContent()),
});

monaco.languages.registerFoldingRangeProvider('markdown', {
  provideFoldingRanges: (model) =>
    markdownFoldingRanges(model.getLinesContent()).map(({ start, end, kind }) =>
      kind === 'region'
        ? { start, end, kind: monaco.languages.FoldingRangeKind.Region }
        : { start, end },
    ),
});

const registered = new Set<string>();

/**
 * Ensure `languageId` paints coloured on its first frame. Idempotent and synchronous — call
 * it before `createModel` / `editor.create`.
 *
 * A language with no bundled Monarch grammar (JSON, whose tokens come from its own language
 * service) falls back to kicking Monaco's lazy factory early rather than leaving it to fire
 * on first paint. That's still async, but it starts one turn sooner and resolves from the
 * bundle, so at worst it costs a single frame instead of a load.
 */
export function ensureTokenizer(languageId: string): void {
  if (registered.has(languageId)) return;
  registered.add(languageId);
  const grammar = GRAMMARS[languageId];
  if (grammar) {
    monaco.languages.setMonarchTokensProvider(languageId, grammar.language);
    monaco.languages.setLanguageConfiguration(languageId, grammar.conf);
    return;
  }
  // `colorize` resolves the tokenization support for a language; the empty input makes it a
  // pure warm-up. Fire-and-forget: a failure just leaves Monaco's own lazy path in place.
  void monaco.editor.colorize('', languageId, {}).catch(() => {});
}
