import type * as monaco from 'monaco-editor';
import type { Grammar } from './gomod-grammar';

// Whole-line, column-0 rules only — see spec 2026-10-08-language-coverage §2.3 (diff row).
// Monarch compiles `@@` in a rule to a literal single `@`, so the range marker is `@{2,3}`.
const RANGE = /^(@{2,3}[^@]*@{2,3})(.*)$/;

const lineRules: monaco.languages.IMonarchLanguageRule[] = [
  [/^\+.*$/, 'string'],
  [/^-.*$/, 'log-error'],
  [/^\\.*$/, 'comment'],
  [/^.+$/, ''],
];

export const diff: Grammar = {
  // Explicitly empty, not absent: absent falls back to every configured bracket pair.
  conf: { colorizedBracketPairs: [] },
  language: {
    defaultToken: '',
    tokenPostfix: '.diff',
    tokenizer: {
      root: [
        [/^diff .*$/, 'keyword'],
        [/^index .*$/, 'keyword'],
        // Ahead of the removed/added rules, which would otherwise take a header line.
        [/^--- .*$/, 'keyword'],
        [/^\+\+\+ .*$/, 'keyword'],
        [RANGE, [{ token: 'type', next: '@hunk' }, '']],
        ...lineRules,
      ],
      // Inside a hunk a `---`/`+++` line is a removed/added line (`-- sql comment`); only the
      // next file's `diff` line ends it.
      hunk: [
        [/^diff .*$/, { token: 'keyword', next: '@pop' }],
        [RANGE, ['type', '']],
        ...lineRules,
      ],
    },
  },
};
