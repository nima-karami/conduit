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

const expansion = (open: string, close: string): monaco.languages.IMonarchLanguageRule[] => [
  [new RegExp(`\\$\\${open}`), { token: 'number', next: '@push' }],
  [new RegExp(`\\${open}`), { token: 'number', next: '@push' }],
  [new RegExp(`\\${close}`), { token: 'number', next: '@pop' }],
  [new RegExp(`[^$\\${open}\\${close}]+`), 'number'],
  [/\$/, 'number'],
];

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
    tokenizer: {
      root: [
        // A recipe line: consuming the TAB leaves only the mid-line rules (strings, expansions,
        // comments) for the rest of it.
        [/^\t/, 'white'],
        [/#.*\\$/, { token: 'comment', next: '@commentContinued' }],
        [/#.*$/, 'comment'],
        [new RegExp(`^\\.(?:${SPECIAL_TARGETS.join('|')})(?![\\w.])`), 'keyword'],
        [new RegExp(`^\\s*(?:${DIRECTIVES.join('|')})(?![\\w.-])`), 'keyword'],
        [/^[ ]*[A-Za-z0-9_.-]+[ \t]*(?::::=|::=|:=|\?=|\+=|!=|=)/, 'keyword'],
        [/^[^\s:#=][^:#=]*?::?(?!=)/, 'type'],
        [/\$\(/, { token: 'number', next: '@paren' }],
        [/\$\{/, { token: 'number', next: '@brace' }],
        [/\$[@<^*?%+|$A-Za-z0-9]/, 'number'],
        [/"(?:[^"\\]|\\.)*"?/, 'string'],
        [/'[^']*'?/, 'string'],
        [/[A-Za-z0-9_.-]+/, ''],
        [/\s+/, 'white'],
      ],
      commentContinued: [
        [/.*\\$/, 'comment'],
        [/.*$/, { token: 'comment', next: '@pop' }],
      ],
      paren: expansion('(', ')'),
      brace: expansion('{', '}'),
    },
  },
};
