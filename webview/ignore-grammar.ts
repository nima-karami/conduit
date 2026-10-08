import type { Grammar } from './gomod-grammar';

// `.gitignore` and its kin — see spec 2026-10-08-language-coverage §2.3 (ignore row).
export const ignore: Grammar = {
  conf: {
    comments: { lineComment: '#' },
    brackets: [['[', ']']],
  },
  language: {
    defaultToken: '',
    tokenPostfix: '.ignore',
    tokenizer: {
      root: [
        [/^#.*$/, 'comment'],
        [/^!/, 'keyword'],
        [/\\./, ''],
        [/\*\*|[*?]/, 'type'],
        // `[` is excluded from the body so an unclosed run of them can't rescan to the line end
        // from every position.
        [/\[[^\][]*\]/, 'type'],
        [/\/(?=\s*$)/, 'type'],
        [/[^\\*?[/\s]+/, ''],
        [/\s+/, 'white'],
      ],
    },
  },
};
