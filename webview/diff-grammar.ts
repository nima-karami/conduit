import type { Grammar } from './gomod-grammar';

// Whole-line, column-0 rules only — see spec 2026-10-08-language-coverage §2.3 (diff row).
export const diff: Grammar = {
  conf: {},
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
        [/^(@@[^@]*@@)(.*)$/, ['type', '']],
        [/^\+.*$/, 'string'],
        [/^-.*$/, 'log-error'],
        [/^\\.*$/, 'comment'],
        [/^.+$/, ''],
      ],
    },
  },
};
