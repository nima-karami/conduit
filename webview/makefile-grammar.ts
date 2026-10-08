import type * as monaco from 'monaco-editor';
import type { Grammar } from './gomod-grammar';

// see spec 2026-10-08-language-coverage §2.3 (Makefile row). `$(` opens a paren-counting state
// rather than a recursive regex, which no linear-time regex can express.

const DIRECTIVES = [
  'include',
  '-include',
  'sinclude',
  'ifeq',
  'ifneq',
  'ifdef',
  'ifndef',
  'else',
  'endif',
  'define',
  'endef',
  'export',
  'unexport',
  'override',
  'undefine',
  'private',
  'vpath',
];

const SPECIAL_TARGETS = [
  'PHONY',
  'SUFFIXES',
  'DEFAULT',
  'PRECIOUS',
  'INTERMEDIATE',
  'NOTINTERMEDIATE',
  'SECONDARY',
  'SECONDEXPANSION',
  'DELETE_ON_ERROR',
  'IGNORE',
  'LOW_RESOLUTION_TIME',
  'SILENT',
  'EXPORT_ALL_VARIABLES',
  'NOTPARALLEL',
  'ONESHELL',
  'POSIX',
];

/**
 * Nesting is counted by one state per depth rather than `@push`: Monaco throws past a stack of
 * 100 (`maxStack`), and `$(` repeated is ordinary input. Past the last depth a bracket no longer
 * counts, which can only mis-colour.
 */
const EXPANSION_DEPTH = 8;

/** `{name}1` … `{name}N` for one bracket pair. The grammar is `includeLF`, so each state sees the
 *  line's `\n`: a `\` before it continues the expansion, anything else unwinds it — an
 *  unterminated `$(` must not colour the rest of the file. */
function expansionStates(
  name: string,
  open: string,
  close: string,
): Record<string, monaco.languages.IMonarchLanguageRule[]> {
  const states: Record<string, monaco.languages.IMonarchLanguageRule[]> = {};
  for (let depth = 1; depth <= EXPANSION_DEPTH; depth++) {
    const deeper: monaco.languages.IMonarchLanguageAction =
      depth < EXPANSION_DEPTH ? { token: 'number', next: `@${name}${depth + 1}` } : 'number';
    states[`${name}${depth}`] = [
      [/\\\n/, 'number'],
      [/(?=\n)/, { token: '', next: '@pop' }],
      [new RegExp(`\\$?\\${open}`), deeper],
      [new RegExp(`\\${close}`), { token: 'number', next: '@pop' }],
      // A `$` that doesn't open this pair joins the run, so `${${…` inside `$(` is one step.
      [new RegExp(`(?:[^$\\\\\\n\\${open}\\${close}]|\\$(?!\\${open}))+`), 'number'],
      [/\\/, 'number'],
    ];
  }
  return states;
}

const ASSIGN = '[A-Za-z0-9_.-]+[ \\t]*(?::::=|::=|:=|\\?=|\\+=|!=|=)';

export const makefile: Grammar = {
  conf: {
    comments: { lineComment: '#' },
    brackets: [
      ['(', ')'],
      ['{', '}'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    folding: { offSide: true },
  },
  language: {
    defaultToken: '',
    tokenPostfix: '.makefile',
    // Lines arrive with their `\n`, which is what lets a `\` continuation be told from a line end.
    includeLF: true,
    tokenizer: {
      root: [
        // A recipe line: consuming the TAB leaves only the mid-line rules (strings, expansions,
        // comments) for the rest of it.
        [/^\t/, 'white'],
        [/#.*\\\n/, { token: 'comment', next: '@commentContinued' }],
        [/#.*/, 'comment'],
        [new RegExp(`^\\.(?:${SPECIAL_TARGETS.join('|')})(?![\\w.])`), 'keyword'],
        [
          new RegExp(`^([ ]*)(export|override|private)([ \\t]+)(${ASSIGN})`),
          ['white', 'keyword', 'white', 'keyword'],
        ],
        [new RegExp(`^\\s*(?:${DIRECTIVES.join('|')})(?![\\w.-])`), 'keyword'],
        [new RegExp(`^[ ]*${ASSIGN}`), 'keyword'],
        [/^[^\s:#=][^:#=\n]*?::?(?!=)/, 'type'],
        [/\$\(/, { token: 'number', next: '@paren1' }],
        [/\$\{/, { token: 'number', next: '@brace1' }],
        [/\$[@<^*?%+|$A-Za-z0-9]/, 'number'],
        [/"(?:[^"\\\n]|\\.)*"?/, 'string'],
        [/'[^'\n]*'?/, 'string'],
        [/[A-Za-z0-9_.-]+/, ''],
        [/\s+/, 'white'],
        // A run of characters no rule above starts with, taken whole rather than one fallback
        // character — and every rule tried — at a time.
        [/[^\s\w#$"'.-]+/, ''],
      ],
      commentContinued: [
        [/.*\\\n/, 'comment'],
        [/.*\n?/, { token: 'comment', next: '@pop' }],
      ],
      ...expansionStates('paren', '(', ')'),
      ...expansionStates('brace', '{', '}'),
    },
  },
};
