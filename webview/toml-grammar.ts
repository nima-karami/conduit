import type * as monaco from 'monaco-editor';
import type { Grammar } from './gomod-grammar';

// see spec 2026-10-08-language-coverage §2.3 (TOML row, linear-time rules)
const BARE = '[A-Za-z0-9_-]+';
const BASIC = '"(?:[^"\\\\]|\\\\.)*"';
const LITERAL = "'[^']*'";
const KEY = `(?:${BARE}|${BASIC}|${LITERAL})`;
const HEADER = /^(\s*)(\[\[?[^\]]*\]\]?)(?=\s*(?:#|$))/;

/**
 * A value's `[` opens an array, which may span lines; inside one, `[1, 2]` on its own line is an
 * element, not a table header. One state per depth rather than `@push`, which Monaco caps at a
 * stack of 100. A header-shaped line at column 0 closes every open array, so an unfinished `[`
 * being typed can't recolour the rest of the file; an element is indented in practice.
 */
const ARRAY_DEPTH = 8;
const arrayStates = Object.fromEntries(
  Array.from({ length: ARRAY_DEPTH }, (_, i): [string, monaco.languages.IMonarchLanguageRule[]] => {
    const depth = i + 1;
    const deeper: monaco.languages.IMonarchLanguageAction =
      depth < ARRAY_DEPTH ? { token: '', next: `@array${depth + 1}` } : '';
    return [
      `array${depth}`,
      [
        [/^(?=\[\[?[^\s\]][^\]]*\]\]?\s*(?:#|$))/, { token: '', next: '@popall' }],
        [/\[/, deeper],
        [/\]/, { token: '', next: '@pop' }],
        { include: '@value' },
      ],
    ];
  }),
);

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
        [HEADER, ['white', 'type']],
        // Column 0 only, so the lookahead over a dotted key runs once per line.
        [new RegExp(`^(\\s*)(${KEY}(?:\\s*\\.\\s*${KEY})*)(?=\\s*=)`), ['white', 'keyword']],
        [/\[/, { token: '', next: '@array1' }],
        { include: '@value' },
      ],
      value: [
        [/#.*$/, 'comment'],
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
        [/[=.,[\]]/, ''],
        [/\s+/, 'white'],
        // A run of characters no rule above starts with, taken whole rather than one fallback
        // character — and every rule tried — at a time.
        [/[^\s\w"'#[\]=.,+-]+/, ''],
      ],
      ...arrayStates,
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
