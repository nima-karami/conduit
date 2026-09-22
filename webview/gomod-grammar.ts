import type * as monaco from 'monaco-editor';

/**
 * `go.mod` / `go.work` — Monaco ships no grammar for them. Kept Monaco-free (type import only)
 * so the rules are unit-testable in the node env. See docs/specs/2026-09-22-go-files-basics.md §3.
 */
export interface Grammar {
  conf: monaco.languages.LanguageConfiguration;
  language: monaco.languages.IMonarchLanguage;
}

export const gomod: Grammar = {
  conf: {
    comments: { lineComment: '//' },
    brackets: [
      ['(', ')'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: '`', close: '`', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: '`', close: '`' },
    ],
  },
  language: {
    defaultToken: '',
    tokenPostfix: '.gomod',
    keywords: [
      'module',
      'go',
      'toolchain',
      'godebug',
      'require',
      'replace',
      'exclude',
      'retract',
      'use',
      'tool',
      'ignore',
    ],
    brackets: [
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
      { open: '[', close: ']', token: 'delimiter.square' },
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/=>/, 'operator'],
        [/[()[\]]/, '@brackets'],
        [/"(?:[^"\\]|\\.)*"?/, 'string'],
        [/`[^`]*`?/, 'string'],
        // Ahead of the identifier rule, which would otherwise swallow `v1.2.3` whole. The
        // lookahead keeps a path such as `v2.example.com/x` an identifier.
        [/v\d+(?:\.\d+){0,2}(?:-[\w.-]+)?(?:\+[\w.]+)?(?![\w./])/, 'number'],
        [/\d+(?:\.\d+)*(?:(?:rc|beta)\d+)?(?![\w./])/, 'number'],
        // Ahead of the identifier rule so a drive-letter target (`C:\fork`) isn't split at `C`.
        [/(?:\.\.?|[A-Za-z]:)?[\\/][^\s()[\]"`]*/, 'identifier'],
        [/[\w][\w.\-/~+]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[,=]/, 'delimiter'],
        [/\s+/, 'white'],
      ],
    },
  },
};
