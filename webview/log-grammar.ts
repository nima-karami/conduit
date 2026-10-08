import type * as monaco from 'monaco-editor';
import type { Grammar } from './gomod-grammar';

/**
 * `.log` files (spec 2026-10-08-language-support §2.2). A level word is coloured when it is
 * UPPERCASE, or — in any case — where a level stands: in brackets, as a `level=` value, or as a
 * leading `error:` (at the line start or right after its timestamp). Lowercase prose such as
 * "I/O error count 0" stays plain. Monarch rebuilds every rule from its `.source`, dropping RegExp
 * flags, so the any-case forms are spelled letter by letter. A rule with a leading `^` matches at
 * column 0 only (monarchCompile `matchOnlyAtLineStart`); an array action tokens the groups.
 */
const ci = (word: string): string =>
  [...word].map((ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`).join('');

const TIERS: { token: string; words: string[] }[] = [
  {
    token: 'log-error',
    words: ['FATAL', 'CRITICAL', 'CRIT', 'ERROR', 'ERR', 'EMERG', 'ALERT', 'PANIC', 'SEVERE'],
  },
  { token: 'log-warn', words: ['WARNING', 'WARN', 'WRN'] },
  { token: 'log-info', words: ['INFO', 'INF', 'NOTICE'] },
  { token: 'comment', words: ['DEBUG', 'DBG', 'TRACE', 'TRC', 'VERBOSE'] },
];

const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const UNIT = 'ns|us|µs|ms|s|m|h|d|[kKMGT]i?B|B|%';
const HEX = '[0-9a-fA-F]';
const ISO_TIME =
  '\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?)?(?:Z|[+-]\\d{2}:?\\d{2})?(?![\\w])';
const SYSLOG_TIME = `(?:${MONTH}) [ \\d]\\d \\d{2}:\\d{2}:\\d{2}(?![\\w])`;
const CLOCK_TIME = '\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?![\\w])';
const TIME = `(?:${ISO_TIME}|${SYSLOG_TIME}|${CLOCK_TIME})`;

function levelRules({
  token,
  words,
}: (typeof TIERS)[number]): monaco.languages.IMonarchLanguageRule[] {
  const any = `(?:${words.map(ci).join('|')})`;
  const upper = `(?:${words.join('|')})`;
  return [
    [new RegExp(`^(${TIME})(\\s+)(${any})(?=:)`), ['log-time', 'white', token]],
    [new RegExp(`^${any}(?=:)`), token],
    [new RegExp(`\\[${any}\\]`), token],
    [new RegExp(`("?level"?\\s*[=:]\\s*"?)(${any})("?)(?![\\w])`), ['', token, '']],
    // The trailing guard rejects `ERRORS`; a leading `TERROR` never reaches this rule because the
    // word rule below consumes it whole.
    [new RegExp(`${upper}(?![\\w])`), token],
  ];
}

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
        ...TIERS.flatMap(levelRules),
        // Muted, so the level beside it is what stands out.
        [new RegExp(TIME), 'log-time'],
        [new RegExp(`${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}(?![\\w])`), 'number'],
        [/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?![\w.])/, 'number'],
        [/0[xX][0-9a-fA-F]+(?![\w])/, 'number'],
        [new RegExp(`\\d+(?:\\.\\d+)?(?:${UNIT})?(?![\\w.])`), 'number'],
        [/[a-zA-Z][\w+.-]*:\/\/[^\s"'<>]+/, 'string'],
        [/"[^"]*"?/, 'string'],
        [/'[^']*'?/, 'string'],
        // Whole words — contractions and dotted names included — so a level word or a quote is
        // never picked out of the middle of one (`TERROR`, `don't`, `v1.2.3`).
        [/[A-Za-z_][\w$]*(?:[.'][\w$]+)*/, ''],
        [/\d[\w.]*/, ''],
        [/\s+/, 'white'],
        [/./, ''],
      ],
    },
  },
};
