/**
 * Runs a grammar through Monaco's own Monarch — `monarchCompile` + `MonarchTokenizer` — so the
 * units test exactly what the editor runs (`@@` → `@`, `maxStack`, group rules, `includeLF`). A
 * hand-written interpreter diverged from it on all three. The tokenizer needs only three services
 * for a grammar that embeds no other language; they are stubbed below.
 */

import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';
import { MonarchTokenizer } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js';
import type { Grammar } from '../../webview/gomod-grammar';

export type GrammarToken = [text: string, token: string];

type Tokenizer = MonarchTokenizer;

const noop = { dispose() {} };
const languageService = {
  languageIdCodec: { encodeLanguageId: () => 0, decodeLanguageId: () => '' },
  getLanguageIdByLanguageName: () => null,
  getLanguageIdByMimeType: () => null,
  isRegisteredLanguageId: () => false,
  requestBasicLanguageFeatures() {},
};
// Monaco skips a line at `editor.maxTokenizationLineLength` (20 000 by default) without
// tokenizing it; lifted so a timing test measures the rules, not that early exit.
const configurationService = {
  getValue: () => Number.MAX_SAFE_INTEGER,
  onDidChangeConfiguration: () => noop,
};

/**
 * A tokenizer over `grammar`, optionally entered in `state`: pushed from a synthetic root at the
 * start of each line, as an earlier rule would push it, so the state's own `@pop` has a parent.
 */
export function monarchTokenizer(grammar: Grammar, state?: string): Tokenizer {
  const json = state
    ? {
        ...grammar.language,
        start: 'enter',
        tokenizer: {
          ...grammar.language.tokenizer,
          enter: [[/^/, { token: '', next: `@${state}` }]],
        },
      }
    : grammar.language;
  const lexer = compile('test', json);
  return new MonarchTokenizer(languageService, {}, 'test', lexer, configurationService);
}

/** Raw Monarch tokens per line: `[offset, type]`, type including the grammar's postfix. */
export function rawTokens(tokenizer: Tokenizer, lines: readonly string[]): [number, string][][] {
  let state = tokenizer.getInitialState();
  return lines.map((line, i) => {
    const r = tokenizer.tokenize(line, i < lines.length - 1, state);
    state = r.endState;
    return r.tokens.map((t) => [t.offset, t.type] as [number, string]);
  });
}

/**
 * Tokens per line with the postfix stripped (`keyword.toml` → `keyword`), plain (`''`) and
 * `white` text dropped so a test names only what is coloured. Monarch itself merges adjacent
 * tokens of one type into a single span. Lines are tokenized as a model
 * tokenizes them: every line but the last carries its EOL.
 */
export function tokenizeLines(grammar: Grammar, lines: readonly string[]): GrammarToken[][] {
  const postfix = (grammar.language as { tokenPostfix?: string }).tokenPostfix ?? '';
  const strip = (type: string) =>
    postfix && type.endsWith(postfix) ? type.slice(0, -postfix.length) : type;
  return rawTokens(monarchTokenizer(grammar), lines).map((tokens, i) => {
    const line = lines[i];
    const out: GrammarToken[] = [];
    tokens.forEach(([offset, type], k) => {
      const end = k + 1 < tokens.length ? tokens[k + 1][0] : line.length;
      // An `includeLF` grammar's tokens can reach the appended `\n`, which isn't line text.
      const text = line.slice(offset, Math.min(end, line.length));
      const token = strip(type);
      if (text !== '' && token !== '' && token !== 'white') out.push([text, token]);
    });
    return out;
  });
}

/** Every tokenizer state's name. */
export const grammarStates = (grammar: Grammar): string[] =>
  Object.keys((grammar.language as { tokenizer: Record<string, unknown> }).tokenizer);

/** Every RegExp in every tokenizer state, for static checks over a grammar's rules. */
export function grammarRegExps(grammar: Grammar): RegExp[] {
  const lang = grammar.language as { tokenizer: Record<string, unknown[]> };
  return Object.values(lang.tokenizer).flatMap((rules) =>
    rules.flatMap((r) => (Array.isArray(r) && r[0] instanceof RegExp ? [r[0]] : [])),
  );
}

/** Every token name a grammar's rules can emit. */
export function grammarTokens(grammar: Grammar): Set<string> {
  const lang = grammar.language as { tokenizer: Record<string, unknown[]> };
  const out = new Set<string>();
  const add = (action: unknown) => {
    if (typeof action === 'string') out.add(action);
    else if (Array.isArray(action)) for (const a of action) add(a);
    else if (action && typeof action === 'object' && 'token' in action) {
      out.add(String((action as { token: unknown }).token));
    }
  };
  for (const rules of Object.values(lang.tokenizer)) {
    for (const r of rules) if (Array.isArray(r)) add(r[1]);
  }
  return out;
}
