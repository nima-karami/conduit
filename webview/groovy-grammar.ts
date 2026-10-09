import type * as monaco from 'monaco-editor';
import * as java from 'monaco-editor/esm/vs/basic-languages/java/java.js';
import type { Grammar } from './gomod-grammar';

// Java's grammar with Groovy's strings and keywords. Gradle/Jenkins DSL words (`pipeline`, `sh`)
// are method calls, not keywords, and stay identifiers.

type Rule = monaco.languages.IMonarchLanguageRule;

/** Interpolation `{…}` counted by one state per depth, not `@push`: Monaco throws past a stack
 *  of 100, and `${` repeated is ordinary input. Past the last depth a brace no longer counts. */
const INTERP_DEPTH = 8;

/** Java's own delimiter and bracket rules sit far down its root, and every rule ahead of them is
 *  tried per token — on `a.b.c` or `f(g(x))` that is most of the tokenizing. Hoisted: no Java
 *  rule ahead of them starts with these characters (no Java number starts with `.`). */
const punctuation: Rule[] = [
  [/[;,.]/, 'delimiter'],
  [/[{}()[\]]/, '@brackets'],
];

const code: Rule[] = [
  ...java.language.tokenizer.root,
  // A run of characters no Java rule starts with (`\`, `#`, `` ` ``…), taken whole: Monarch's
  // fallback otherwise tries every rule per character.
  [/[^\w\s$"'{}()[\]<>=!~?:&|+\-*/^%@;,.]+/, ''],
];

/** Inside `${…}` a quote is a one-line string with no interpolation of its own, so the stack is
 *  bounded by INTERP_DEPTH whatever the input. */
const interpStrings: Rule[] = [
  [/"(?:[^"\\]|\\.)*"?/, 'string'],
  [/'(?:[^'\\]|\\.)*'?/, 'string'],
];

function interpStates(): Record<string, Rule[]> {
  const states: Record<string, Rule[]> = {};
  for (let depth = 1; depth <= INTERP_DEPTH; depth++) {
    const open =
      depth < INTERP_DEPTH ? { token: 'delimiter.bracket', next: `@interp${depth + 1}` } : '';
    states[`interp${depth}`] = [
      [/\{/, open],
      [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
      ...punctuation,
      ...interpStrings,
      ...code,
    ];
  }
  return states;
}

/** A lone `\` is a line continuation, which keeps the string open. */
const escapes: Rule[] = [
  [/@escapes/, 'string.escape'],
  [/\\./, 'string.escape.invalid'],
  [/\\/, 'string'],
];

/** A GString body; `close` is its closing quote run. */
function gstring(close: RegExp): Rule[] {
  return [
    [/[^\\"$]+/, 'string'],
    ...escapes,
    [/\$\{/, { token: 'delimiter.bracket', next: '@interp1' }],
    [/\$[A-Za-z_]\w*/, 'identifier'],
    [/\$/, 'string'],
    [close, { token: 'string', next: '@pop' }],
    [/"/, 'string'],
  ];
}

export const groovy: Grammar = {
  conf: java.conf,
  language: {
    ...java.language,
    tokenPostfix: '.groovy',
    keywords: [...(java.language.keywords as string[]), 'def', 'in', 'as', 'trait', 'null', 'var'],
    escapes: /\\(?:[bfnrts\\"'$]|u[0-9A-Fa-f]{4})/,
    tokenizer: {
      ...java.language.tokenizer,
      // Ahead of Java's root, whose `'` rules read a char literal and mark any longer one invalid.
      root: [
        ...punctuation,
        [/'''/, { token: 'string', next: '@tripleSingle' }],
        [/"""/, { token: 'string', next: '@tripleDouble' }],
        // Unterminated on its line: Groovy's `'…'`/`"…"` can't span lines, so it mustn't colour
        // the rest of the file. A trailing `\` fails this match and continues the string.
        [/'(?:[^'\\]|\\.)*$/, 'string.invalid'],
        [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
        [/'/, { token: 'string', next: '@single' }],
        [/"/, { token: 'string', next: '@double' }],
        ...code,
      ],
      single: [[/[^\\']+/, 'string'], ...escapes, [/'/, { token: 'string', next: '@pop' }]],
      tripleSingle: [
        [/[^\\']+/, 'string'],
        ...escapes,
        [/'''/, { token: 'string', next: '@pop' }],
        [/'/, 'string'],
      ],
      double: gstring(/"/),
      tripleDouble: gstring(/"""/),
      ...interpStates(),
    },
  },
};
