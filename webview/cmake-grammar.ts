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
    tokenizer: {
      root: [
        ...BRACKET_LEVELS.map(
          (n): monaco.languages.IMonarchLanguageRule => [
            new RegExp(`#\\[={${n}}\\[`),
            { token: 'comment', next: `@bracketComment${n}` },
          ],
        ),
        [/#.*$/, 'comment'],
        ...BRACKET_LEVELS.map(
          (n): monaco.languages.IMonarchLanguageRule => [
            new RegExp(`\\[={${n}}\\[`),
            { token: 'string', next: `@bracketArgument${n}` },
          ],
        ),
        [/[A-Za-z_][A-Za-z0-9_]*(?=[ \t]*\()/, 'keyword'],
        [VAR_OPEN, { token: 'number', next: '@variable' }],
        [/"/, { token: 'string', next: '@quoted' }],
        [/(?:ON|OFF|TRUE|FALSE|YES|NO)(?![\w.-])/, 'number'],
        [/\d[\d.]*(?![\w])/, 'number'],
        [/[A-Za-z_][\w.-]*/, ''],
        [/\s+/, 'white'],
      ],
      quoted: [
        [/"/, { token: 'string', next: '@pop' }],
        [VAR_OPEN, { token: 'number', next: '@variable' }],
        [/[^"\\$]+/, 'string'],
        [/\\./, 'string'],
        [/[\\$]/, 'string'],
      ],
      variable: [
        [VAR_OPEN, { token: 'number', next: '@push' }],
        [/\}/, { token: 'number', next: '@pop' }],
        [/[^${}]+/, 'number'],
        [/\$/, 'number'],
      ],
      ...bracketStates,
    },
  },
};
