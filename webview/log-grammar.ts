import type { Grammar } from './gomod-grammar';

/**
 * `.log` files (spec 2026-10-08-language-support §2.2). Monarch rebuilds every rule from its
 * `.source`, dropping RegExp flags, and a lexer-wide `ignoreCase` would also loosen the
 * case-sensitive exception-headline rule — so level words are case-insensitive letter by letter.
 * A rule with a leading `^` matches at column 0 only (monarchCompile `matchOnlyAtLineStart`).
 */
const ci = (word: string): string =>
  [...word].map((ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`).join('');

// The trailing guard rejects `errors=0`; a leading `terror` never reaches this rule because the
// word rule below consumes it whole.
const levels = (list: string[]): RegExp => new RegExp(`(?:${list.map(ci).join('|')})(?![\\w])`);

const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const UNIT = 'ns|us|µs|ms|s|m|h|d|[kKMGT]i?B|B|%';
const HEX = '[0-9a-fA-F]';

export const log: Grammar = {
  conf: {
    brackets: [
      ['[', ']'],
      ['(', ')'],
      ['{', '}'],
    ],
  },
  language: {
    defaultToken: '',
    tokenPostfix: '.log',
    tokenizer: {
      root: [
        [/^\s+at\s.*$/, 'comment'],
        [/^\s+File ".*", line \d+.*$/, 'comment'],
        [/^\s+\.\.\. \d+ more.*$/, 'comment'],
        [/^Traceback \(most recent call last\):/, 'log-error'],
        [/^\S*(?:Exception|Error)(?::|\b)/, 'log-error'],
        // The `X/Tag(pid):` shape is what tells a logcat level from prose such as `I/O error`.
        [/^[EF]\/\S+\(\s*\d+\):/, 'log-error'],
        [/^W\/\S+\(\s*\d+\):/, 'log-warn'],
        [/^I\/\S+\(\s*\d+\):/, 'log-info'],
        [/^[DV]\/\S+\(\s*\d+\):/, 'comment'],
        [/\[E\]/, 'log-error'],
        [/\[W\]/, 'log-warn'],
        [/\[I\]/, 'log-info'],
        [/\[[DTV]\]/, 'comment'],
        [
          levels([
            'FATAL',
            'CRITICAL',
            'CRIT',
            'ERROR',
            'ERR',
            'EMERG',
            'ALERT',
            'PANIC',
            'SEVERE',
          ]),
          'log-error',
        ],
        [levels(['WARNING', 'WARN', 'WRN']), 'log-warn'],
        [levels(['INFO', 'INF', 'NOTICE']), 'log-info'],
        [levels(['DEBUG', 'DBG', 'TRACE', 'TRC', 'VERBOSE']), 'comment'],
        [
          /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\w])/,
          'number',
        ],
        [new RegExp(`(?:${MONTH}) [ \\d]\\d \\d{2}:\\d{2}:\\d{2}(?![\\w])`), 'number'],
        [/\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?![\w])/, 'number'],
        [new RegExp(`${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}(?![\\w])`), 'number'],
        [/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?![\w.])/, 'number'],
        [/0[xX][0-9a-fA-F]+(?![\w])/, 'number'],
        [new RegExp(`\\d+(?:\\.\\d+)?(?:${UNIT})?(?![\\w.])`), 'number'],
        [/[a-zA-Z][\w+.-]*:\/\/[^\s"'<>]+/, 'string'],
        [/"[^"]*"?/, 'string'],
        [/'[^']*'?/, 'string'],
        // Whole words — contractions and dotted names included — so a level word or a quote is
        // never picked out of the middle of one (`terror`, `don't`, `v1.2.3`).
        [/[A-Za-z_][\w$]*(?:[.'][\w$]+)*/, ''],
        [/\d[\w.]*/, ''],
        [/\s+/, 'white'],
        [/./, ''],
      ],
    },
  },
};
