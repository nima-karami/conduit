import type { Grammar } from './gomod-grammar';

// see spec 2026-10-08-language-coverage §2.3 (TOML row, linear-time rules)
const BARE = '[A-Za-z0-9_-]+';
const BASIC = '"(?:[^"\\\\]|\\\\.)*"';
const LITERAL = "'[^']*'";
const KEY = `(?:${BARE}|${BASIC}|${LITERAL})`;

export const toml: Grammar = {
  conf: {
    comments: { lineComment: '#' },
    brackets: [
      ['[', ']'],
      ['{', '}'],
    ],
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    folding: { offSide: true },
  },
  language: {
    defaultToken: '',
    tokenPostfix: '.toml',
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        // The trailing guard keeps an array of arrays inside a multi-line value from reading as
        // a table header.
        [/^(\s*)(\[\[?[^\]]*\]\]?)(?=\s*(?:#|$))/, ['white', 'type']],
        // Column 0 only, so the lookahead over a dotted key runs once per line.
        [new RegExp(`^(\\s*)(${KEY}(?:\\s*\\.\\s*${KEY})*)(?=\\s*=)`), ['white', 'keyword']],
        [/"""/, { token: 'string', next: '@mlBasic' }],
        [/'''/, { token: 'string', next: '@mlLiteral' }],
        [/"(?:[^"\\]|\\.)*"?/, 'string'],
        [/'[^']*'?/, 'string'],
        // An inline-table key; the bare-word rule below consumes the whole run when this fails.
        [/[A-Za-z0-9_-]+(?=\s*=)/, 'keyword'],
        [
          /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?(?![\w:])/,
          'number',
        ],
        [/\d{2}:\d{2}:\d{2}(?:\.\d+)?(?![\w:])/, 'number'],
        [/0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+/, 'number'],
        [/[+-]?(?:inf|nan)(?![\w-])/, 'number'],
        [/(?:true|false)(?![\w-])/, 'number'],
        [/[+-]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?(?![\w-])/, 'number'],
        [/[A-Za-z0-9_+-]+/, ''],
        [/[=.,{}[\]]/, ''],
        [/\s+/, 'white'],
      ],
      mlBasic: [
        [/"""/, { token: 'string', next: '@pop' }],
        [/[^"\\]+/, 'string'],
        [/\\./, 'string'],
        [/["\\]/, 'string'],
      ],
      mlLiteral: [
        [/'''/, { token: 'string', next: '@pop' }],
        [/[^']+/, 'string'],
        [/'/, 'string'],
      ],
    },
  },
};
