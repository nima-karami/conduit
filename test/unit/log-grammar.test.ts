/** The real tokenizer is covered by language-files.e2e. */

import { describe, expect, it } from 'vitest';
import { log } from '../../webview/log-grammar';
import { tokenizeLines } from './grammar-runner';

const tokenize = (line: string) => tokenizeLines(log, [line])[0];

const tokenOf = (line: string, text: string) => tokenize(line).find(([t]) => t === text)?.[1];

describe('log grammar', () => {
  it('paints the AC-A2 line: muted timestamp, level, string', () => {
    expect(tokenize('2026-10-08T12:00:00.123Z ERROR boom "x"')).toEqual([
      ['2026-10-08T12:00:00.123Z', 'log-time'],
      ['ERROR', 'log-error'],
      ['"x"', 'string'],
    ]);
  });

  it('reads every UPPERCASE error level word, and bracketed / logcat error', () => {
    for (const w of [
      'FATAL',
      'CRITICAL',
      'CRIT',
      'ERROR',
      'ERR',
      'EMERG',
      'ALERT',
      'PANIC',
      'SEVERE',
    ]) {
      expect(tokenOf(`x ${w} y`, w), w).toBe('log-error');
    }
    expect(tokenOf('[E] boom', '[E]')).toBe('log-error');
    expect(tokenize('E/ActivityManager( 123): died')[0]).toEqual([
      'E/ActivityManager( 123):',
      'log-error',
    ]);
  });

  it('reads UPPERCASE warn, info and debug tiers', () => {
    for (const w of ['WARNING', 'WARN', 'WRN']) expect(tokenOf(`a ${w} b`, w), w).toBe('log-warn');
    for (const w of ['INFO', 'INF', 'NOTICE']) expect(tokenOf(`a ${w} b`, w), w).toBe('log-info');
    for (const w of ['DEBUG', 'DBG', 'TRACE', 'TRC', 'VERBOSE']) {
      expect(tokenOf(`a ${w} b`, w), w).toBe('comment');
    }
    expect(tokenOf('[W] x', '[W]')).toBe('log-warn');
    expect(tokenOf('[I] x', '[I]')).toBe('log-info');
    for (const b of ['[D]', '[T]', '[V]']) expect(tokenOf(`${b} x`, b)).toBe('comment');
    expect(tokenize('W/Tag(9): slow')[0]).toEqual(['W/Tag(9):', 'log-warn']);
    expect(tokenize('I/Tag(9): up')[0]).toEqual(['I/Tag(9):', 'log-info']);
  });

  it('leaves level words in prose alone unless they are UPPERCASE', () => {
    expect(tokenize('I/O error count 0')).toEqual([['0', 'number']]);
    expect(tokenize('a warning about info, nothing critical')).toEqual([]);
    expect(tokenize("don't panic at 5")).toEqual([['5', 'number']]);
  });

  it('reads a level in any case where a level stands: brackets, level=, a leading "x:"', () => {
    expect(tokenOf('[error] boom', '[error]')).toBe('log-error');
    expect(tokenOf('[Warning] slow', '[Warning]')).toBe('log-warn');
    expect(tokenOf('[info] up', '[info]')).toBe('log-info');
    expect(tokenOf('[debug] x', '[debug]')).toBe('comment');
    expect(tokenOf('ts=1 level=error msg=x', 'error')).toBe('log-error');
    expect(tokenOf('{"level":"warn","msg":"x"}', 'warn')).toBe('log-warn');
    expect(tokenOf('level: Info', 'Info')).toBe('log-info');
    expect(tokenize('error: disk full')[0]).toEqual(['error', 'log-error']);
    expect(tokenize('warning: deprecated')[0]).toEqual(['warning', 'log-warn']);
    expect(tokenize('2026-10-08 12:00:00 warn: slow')).toEqual([
      ['2026-10-08 12:00:00', 'log-time'],
      ['warn', 'log-warn'],
    ]);
  });

  it('matches level words on word boundaries only', () => {
    expect(tokenize('ERRORS=0 TERROR INFOS WARNED')).toEqual([['0', 'number']]);
    expect(tokenOf('MY_ERROR happened', 'ERROR')).toBeUndefined();
    expect(tokenOf('ERR_CONNECTION_RESET', 'ERR')).toBeUndefined();
    expect(tokenOf('xlevel=error', 'error')).toBeUndefined();
  });

  it('does not read prose shaped like a logcat tag as a level', () => {
    expect(tokenize('I/O failure')).toEqual([]);
    expect(tokenize('I/O ERROR on disk')).toEqual([['ERROR', 'log-error']]);
  });

  it('greys stack frames whole', () => {
    expect(tokenize('    at com.x.Main.run(Main.java:12)')).toEqual([
      ['    at com.x.Main.run(Main.java:12)', 'comment'],
    ]);
    expect(tokenize('  File "app.py", line 3, in <module>')).toEqual([
      ['  File "app.py", line 3, in <module>', 'comment'],
    ]);
    expect(tokenize('\t... 12 more')).toEqual([['\t... 12 more', 'comment']]);
  });

  it('reads exception headlines and Python tracebacks as errors', () => {
    expect(tokenize('java.lang.NullPointerException: boom')[0]).toEqual([
      'java.lang.NullPointerException:',
      'log-error',
    ]);
    expect(tokenize('TypeError: x is undefined')[0]).toEqual(['TypeError:', 'log-error']);
    expect(tokenize('Traceback (most recent call last):')).toEqual([
      ['Traceback (most recent call last):', 'log-error'],
    ]);
    expect(tokenOf('MyErrorHandler started', 'MyErrorHandler')).toBeUndefined();
  });

  it('mutes timestamps in their common shapes', () => {
    expect(tokenize('2026-10-08 12:00:00,5 x')[0]).toEqual(['2026-10-08 12:00:00,5', 'log-time']);
    expect(tokenize('2026-10-08T12:00:00+02:00 x')[0]).toEqual([
      '2026-10-08T12:00:00+02:00',
      'log-time',
    ]);
    expect(tokenize('12:34:56.789 x')[0]).toEqual(['12:34:56.789', 'log-time']);
    expect(tokenize('Oct  8 12:00:01 host sshd')[0]).toEqual(['Oct  8 12:00:01', 'log-time']);
  });

  it('reads GUIDs, addresses, hex and numbers with units', () => {
    expect(
      tokenOf('id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 x', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    ).toBe('number');
    expect(tokenOf('from 10.0.0.1:8080 ok', '10.0.0.1:8080')).toBe('number');
    expect(tokenOf('addr 0xDEADbeef', '0xDEADbeef')).toBe('number');
    for (const n of ['12ms', '3.4s', '512KB', '42', '99%']) {
      expect(tokenOf(`took ${n} total`, n), n).toBe('number');
    }
    expect(tokenOf('v1.2.3 build', '1.2.3')).toBeUndefined();
  });

  it('reads strings and URLs; an unterminated quote runs to the end of the line', () => {
    expect(tokenOf("say 'hi' now", "'hi'")).toBe('string');
    expect(tokenOf('GET https://example.com/a?b=1 200', 'https://example.com/a?b=1')).toBe(
      'string',
    );
    expect(tokenize('msg "open forever')).toEqual([['"open forever', 'string']]);
  });

  it("keeps an apostrophe inside a word from opening a string (don't)", () => {
    expect(tokenize("don't PANIC at 5")).toEqual([
      ['PANIC', 'log-error'],
      ['5', 'number'],
    ]);
  });

  it('still finds levels, strings and numbers right after a run of punctuation', () => {
    expect(tokenize('=====ERROR===== 5')).toEqual([
      ['ERROR', 'log-error'],
      ['5', 'number'],
    ]);
    expect(tokenOf('--::[[E] boom', '[E]')).toBe('log-error');
    expect(tokenOf('>>>"quoted"', '"quoted"')).toBe('string');
  });

  it('declares bracket pairs and no comment syntax', () => {
    expect(log.conf.comments).toBeUndefined();
    expect(log.conf.brackets).toEqual([
      ['[', ']'],
      ['(', ')'],
      ['{', '}'],
    ]);
  });
});
