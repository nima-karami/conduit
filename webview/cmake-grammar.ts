import type * as monaco from 'monaco-editor';
import type { Grammar } from './gomod-grammar';

// see spec 2026-10-08-language-coverage §2.3 (CMake row). Bracket arguments and comments close
// only on the same number of `=`; the runner subset has no `$1` state arguments, so each level is
// its own state, generated below.
const BRACKET_LEVELS = [0, 1, 2, 3];

const bracketState = (level: number, token: string): monaco.languages.IMonarchLanguageRule[] => [
  [new RegExp(`\\]={${level}}\\]`), { token, next: '@pop' }],
  [/[^\]]+/, token],
  [/\]/, token],
];

const bracketStates = Object.fromEntries(
  BRACKET_LEVELS.flatMap((n) => [
    [`bracketComment${n}`, bracketState(n, 'comment')],
    [`bracketArgument${n}`, bracketState(n, 'string')],
  ]),
);

const VAR_OPEN = /\$(?:ENV|CACHE)?\{/;

/** Monarch rebuilds every rule from its `.source`, dropping RegExp flags. */
const anyCase = (word: string): string =>
  [...word].map((ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`).join('');
const BOOLEANS = ['ON', 'OFF', 'TRUE', 'FALSE', 'YES', 'NO'];

/**
 * `${…}` nests by one state per depth, not `@push`: Monaco throws past a stack of 100. The
 * grammar is `includeLF`, so a reference left open at the line's `\n` unwinds — a reference can't
 * span lines, and an unterminated one must not colour the rest of the file. Unwinding stops at
 * whatever opened it, so a quoted argument stays open across lines.
 */
const VARIABLE_DEPTH = 8;
const variableStates = Object.fromEntries(
  Array.from(
    { length: VARIABLE_DEPTH },
    (_, i): [string, monaco.languages.IMonarchLanguageRule[]] => {
      const depth = i + 1;
      const deeper: monaco.languages.IMonarchLanguageAction =
        depth < VARIABLE_DEPTH ? { token: 'number', next: `@variable${depth + 1}` } : 'number';
      return [
        `variable${depth}`,
        [
          [/(?=\n)/, { token: '', next: '@pop' }],
          [VAR_OPEN, deeper],
          [/\}/, { token: 'number', next: '@pop' }],
          [/[^${}\n]+/, 'number'],
          [/\$/, 'number'],
        ],
      ];
    },
  ),
);

export const cmake: Grammar = {
  conf: {
    comments: { lineComment: '#', blockComment: ['#[[', ']]'] },
    brackets: [['(', ')']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
    folding: { offSide: true },
  },
  language: {
    defaultToken: '',
    tokenPostfix: '.cmake',
    includeLF: true,
    tokenizer: {
      root: [
        ...BRACKET_LEVELS.map(
          (n): monaco.languages.IMonarchLanguageRule => [
            new RegExp(`#\\[={${n}}\\[`),
            { token: 'comment', next: `@bracketComment${n}` },
          ],
        ),
        [/#.*/, 'comment'],
        ...BRACKET_LEVELS.map(
          (n): monaco.languages.IMonarchLanguageRule => [
            new RegExp(`\\[={${n}}\\[`),
            { token: 'string', next: `@bracketArgument${n}` },
          ],
        ),
        [/[A-Za-z_][A-Za-z0-9_]*(?=[ \t]*\()/, 'keyword'],
        [VAR_OPEN, { token: 'number', next: '@variable1' }],
        [/"/, { token: 'string', next: '@quoted' }],
        [new RegExp(`(?:${BOOLEANS.map(anyCase).join('|')})(?![\\w.-])`), 'number'],
        [/\d[\d.]*(?![\w.-])/, 'number'],
        // Takes the whole run the number rule gave up on, so a long digit run followed by a
        // letter is one failed attempt, not one per character.
        [/[\w.-]+/, ''],
        [/\s+/, 'white'],
        // A run of characters no rule above starts with, taken whole rather than one fallback
        // character — and every rule tried — at a time.
        [/[^\s\w#[$".-]+/, ''],
      ],
      quoted: [
        [/"/, { token: 'string', next: '@pop' }],
        [VAR_OPEN, { token: 'number', next: '@variable1' }],
        [/[^"\\$]+/, 'string'],
        [/\\[\s\S]/, 'string'],
        [/[\\$]/, 'string'],
      ],
      ...variableStates,
      ...bracketStates,
    },
  },
};
