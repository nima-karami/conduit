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
import * as clojure from 'monaco-editor/esm/vs/basic-languages/clojure/clojure.js';
import * as cpp from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import * as csharp from 'monaco-editor/esm/vs/basic-languages/csharp/csharp.js';
import * as css from 'monaco-editor/esm/vs/basic-languages/css/css.js';
import * as dart from 'monaco-editor/esm/vs/basic-languages/dart/dart.js';
import * as dockerfile from 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.js';
import * as elixir from 'monaco-editor/esm/vs/basic-languages/elixir/elixir.js';
import * as fsharp from 'monaco-editor/esm/vs/basic-languages/fsharp/fsharp.js';
import * as go from 'monaco-editor/esm/vs/basic-languages/go/go.js';
import * as graphql from 'monaco-editor/esm/vs/basic-languages/graphql/graphql.js';
import * as hcl from 'monaco-editor/esm/vs/basic-languages/hcl/hcl.js';
import * as html from 'monaco-editor/esm/vs/basic-languages/html/html.js';
import * as ini from 'monaco-editor/esm/vs/basic-languages/ini/ini.js';
import * as java from 'monaco-editor/esm/vs/basic-languages/java/java.js';
import * as julia from 'monaco-editor/esm/vs/basic-languages/julia/julia.js';
import * as kotlin from 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js';
import * as less from 'monaco-editor/esm/vs/basic-languages/less/less.js';
import * as lua from 'monaco-editor/esm/vs/basic-languages/lua/lua.js';
import * as markdown from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js';
import * as mdx from 'monaco-editor/esm/vs/basic-languages/mdx/mdx.js';
import * as pascal from 'monaco-editor/esm/vs/basic-languages/pascal/pascal.js';
import * as perl from 'monaco-editor/esm/vs/basic-languages/perl/perl.js';
import * as php from 'monaco-editor/esm/vs/basic-languages/php/php.js';
import * as powershell from 'monaco-editor/esm/vs/basic-languages/powershell/powershell.js';
import * as protobuf from 'monaco-editor/esm/vs/basic-languages/protobuf/protobuf.js';
import * as python from 'monaco-editor/esm/vs/basic-languages/python/python.js';
import * as r from 'monaco-editor/esm/vs/basic-languages/r/r.js';
import * as ruby from 'monaco-editor/esm/vs/basic-languages/ruby/ruby.js';
import * as rust from 'monaco-editor/esm/vs/basic-languages/rust/rust.js';
import * as scala from 'monaco-editor/esm/vs/basic-languages/scala/scala.js';
import * as scss from 'monaco-editor/esm/vs/basic-languages/scss/scss.js';
import * as shell from 'monaco-editor/esm/vs/basic-languages/shell/shell.js';
import * as solidity from 'monaco-editor/esm/vs/basic-languages/solidity/solidity.js';
import * as sql from 'monaco-editor/esm/vs/basic-languages/sql/sql.js';
import * as swift from 'monaco-editor/esm/vs/basic-languages/swift/swift.js';
import * as tcl from 'monaco-editor/esm/vs/basic-languages/tcl/tcl.js';
import * as typescript from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';
import * as vb from 'monaco-editor/esm/vs/basic-languages/vb/vb.js';
import * as xml from 'monaco-editor/esm/vs/basic-languages/xml/xml.js';
import * as yaml from 'monaco-editor/esm/vs/basic-languages/yaml/yaml.js';

interface Grammar {
  conf: monaco.languages.LanguageConfiguration;
  language: monaco.languages.IMonarchLanguage;
}

/**
 * Keyed by the language ids `src/lang.ts` produces, so every extension the app maps to a
 * language paints on the first frame. JS shares Monaco's TypeScript grammar (it covers JSX
 * and plain JS), and C shares C++'s — the same pairing Monaco's own contributions use.
 */
const GRAMMARS: Record<string, Grammar> = {
  bat,
  c: cpp,
  clojure,
  cpp,
  csharp,
  css,
  dart,
  dockerfile,
  elixir,
  fsharp,
  go,
  graphql,
  hcl,
  html,
  ini,
  java,
  javascript: typescript,
  julia,
  kotlin,
  less,
  lua,
  markdown,
  mdx,
  pascal,
  perl,
  php,
  powershell,
  proto: protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  shell,
  sol: solidity,
  sql,
  swift,
  tcl,
  typescript,
  vb,
  xml,
  yaml,
};

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
