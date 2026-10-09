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
  // Java's `//.*$` never matches once the line carries its `\n` (`$` is end of input).
  [/\/\/.*/, 'comment'],
  ...java.language.tokenizer.root,
  // A run of characters no Java rule starts with (`\`, `#`, `` ` ``…), taken whole: Monarch's
  // fallback otherwise tries every rule per character.
  [/[^\w\s$"'{}()[\]<>=!~?:&|+\-*/^%@;,.]+/, ''],
];

/** Inside `${…}` a quote is a one-line string with no interpolation of its own, so the stack is
 *  bounded by INTERP_DEPTH whatever the input. */
const interpStrings: Rule[] = [
  [/"(?:[^"\\\n]|\\.)*"?/, 'string'],
  [/'(?:[^'\\\n]|\\.)*'?/, 'string'],
];

/** `{prefix}1…N`. A `"…"` can't span lines, so its interpolation unwinds to root at the line
 *  end (`root → double → interp…` is the only way in); a `"""…"""`'s may span lines. */
function interpStates(prefix: string, oneLine: boolean): Record<string, Rule[]> {
  const states: Record<string, Rule[]> = {};
  for (let depth = 1; depth <= INTERP_DEPTH; depth++) {
    const open =
      depth < INTERP_DEPTH ? { token: 'delimiter.bracket', next: `@${prefix}${depth + 1}` } : '';
    states[`${prefix}${depth}`] = [
      ...(oneLine ? [[/\n/, { token: '', next: '@popall' }] as Rule] : []),
      [/\{/, open],
      [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
      ...punctuation,
      ...interpStrings,
      ...code,
    ];
  }
  return states;
}

/** A `\` before the line end continues the string onto the next line. */
const escapes: Rule[] = [
  [/@escapes/, 'string.escape'],
  [/\\./, 'string.escape.invalid'],
  [/\\\n?/, 'string'],
];

const gstringParts = (interp: string): Rule[] => [
  ...escapes,
  [/\$\{/, { token: 'delimiter.bracket', next: interp }],
  [/\$[A-Za-z_]\w*/, 'identifier'],
  [/\$/, 'string'],
];

const endOfLine: Rule = [/\n/, { token: '', next: '@pop' }];

export const groovy: Grammar = {
  conf: java.conf,
  language: {
    ...java.language,
    tokenPostfix: '.groovy',
    // Lines arrive with their `\n`, which is what lets a one-line string end at the line end.
    includeLF: true,
    keywords: [...(java.language.keywords as string[]), 'def', 'in', 'as', 'trait', 'null', 'var'],
    escapes: /\\(?:[bfnrts\\"'$]|u[0-9A-Fa-f]{4})/,
    tokenizer: {
      ...java.language.tokenizer,
      // Ahead of Java's root, whose `'` rules read a char literal and mark any longer one invalid.
      root: [
        ...punctuation,
        [/'''/, { token: 'string', next: '@tripleSingle' }],
        [/"""/, { token: 'string', next: '@tripleDouble' }],
        // Unterminated with nothing inside to stop it: taken whole. A trailing `\` fails this
        // (`.` doesn't match `\n`) and continues the string.
        [/'(?:[^'\\\n]|\\.)*\n?$/, 'string.invalid'],
        [/"(?:[^"\\\n]|\\.)*\n?$/, 'string.invalid'],
        [/'/, { token: 'string', next: '@single' }],
        [/"/, { token: 'string', next: '@double' }],
        ...code,
      ],
      single: [
        [/[^\\'\n]+/, 'string'],
        ...escapes,
        [/'/, { token: 'string', next: '@pop' }],
        endOfLine,
      ],
      tripleSingle: [
        [/[^\\']+/, 'string'],
        ...escapes,
        [/'''/, { token: 'string', next: '@pop' }],
        [/'/, 'string'],
      ],
      double: [
        [/[^\\"$\n]+/, 'string'],
        ...gstringParts('@interp1'),
        [/"/, { token: 'string', next: '@pop' }],
        endOfLine,
      ],
      tripleDouble: [
        [/[^\\"$]+/, 'string'],
        ...gstringParts('@tripleInterp1'),
        [/"""/, { token: 'string', next: '@pop' }],
        [/"/, 'string'],
      ],
      ...interpStates('interp', true),
      ...interpStates('tripleInterp', false),
    },
  },
};
