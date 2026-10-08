/**
 * The log Monarch rules run the way Monarch runs them: first rule whose regex matches anchored at
 * the cursor wins, and a rule written with a leading `^` only ever matches at column 0
 * (monarchCompile's `matchOnlyAtLineStart`). The real tokenizer is covered by language-files.e2e.
 */

import { describe, expect, it } from 'vitest';
import { log } from '../../webview/log-grammar';

type Rule = [RegExp, string];

const rules = (log.language as unknown as { tokenizer: { root: Rule[] } }).tokenizer.root.map(
  ([re, token]) => {
    const atStart = re.source.startsWith('^');
    const body = atStart ? re.source.slice(1) : re.source;
    return { re: new RegExp(`^(?:${body})`), atStart, token };
  },
);

function tokenize(line: string): [string, string][] {
  const out: [string, string][] = [];
  let pos = 0;
  while (pos < line.length) {
    const rest = line.slice(pos);
    let hit: [string, string] | null = null;
    for (const r of rules) {
      if (r.atStart && pos > 0) continue;
      const m = r.re.exec(rest);
      if (!m || m[0] === '') continue;
      hit = [m[0], r.token];
      break;
    }
    if (!hit) throw new Error(`no rule matched at ${pos} in ${JSON.stringify(line)}`);
    pos += hit[0].length;
    if (hit[1] !== 'white' && hit[1] !== '') out.push(hit);
  }
  return out;
}

const tokenOf = (line: string, text: string) => tokenize(line).find(([t]) => t === text)?.[1];

describe('log grammar', () => {
  it('paints the AC-A2 line: timestamp, level, string', () => {
    expect(tokenize('2026-10-08T12:00:00.123Z ERROR boom "x"')).toEqual([
      ['2026-10-08T12:00:00.123Z', 'number'],
      ['ERROR', 'log-error'],
      ['"x"', 'string'],
    ]);
  });

  it('reads every error level word in any case, and bracketed / logcat error', () => {
    for (const w of [
      'FATAL',
      'critical',
      'Crit',
      'ERROR',
      'err',
      'EMERG',
      'alert',
      'PANIC',
      'Severe',
    ]) {
      expect(tokenOf(`x ${w} y`, w), w).toBe('log-error');
    }
    expect(tokenOf('[E] boom', '[E]')).toBe('log-error');
    expect(tokenize('E/ActivityManager( 123): died')[0]).toEqual([
      'E/ActivityManager( 123):',
      'log-error',
    ]);
  });

  it('reads warn, info and debug tiers', () => {
    for (const w of ['WARNING', 'warn', 'WRN']) expect(tokenOf(`a ${w} b`, w), w).toBe('log-warn');
    for (const w of ['INFO', 'inf', 'Notice']) expect(tokenOf(`a ${w} b`, w), w).toBe('log-info');
    for (const w of ['DEBUG', 'dbg', 'TRACE', 'TRC', 'Verbose']) {
      expect(tokenOf(`a ${w} b`, w), w).toBe('comment');
    }
    expect(tokenOf('[W] x', '[W]')).toBe('log-warn');
    expect(tokenOf('[I] x', '[I]')).toBe('log-info');
    for (const b of ['[D]', '[T]', '[V]']) expect(tokenOf(`${b} x`, b)).toBe('comment');
    expect(tokenize('W/Tag(9): slow')[0]).toEqual(['W/Tag(9):', 'log-warn']);
    expect(tokenize('I/Tag(9): up')[0]).toEqual(['I/Tag(9):', 'log-info']);
  });

  it('matches level words on word boundaries only', () => {
    expect(tokenize('errors=0 terror infos warned')).toEqual([['0', 'number']]);
    expect(tokenOf('MY_ERROR happened', 'ERROR')).toBeUndefined();
    expect(tokenOf('ERR_CONNECTION_RESET', 'ERR')).toBeUndefined();
  });

  it('does not read prose shaped like a logcat tag as a level', () => {
    expect(tokenize('I/O error on disk')).toEqual([['error', 'log-error']]);
    expect(tokenize('I/O failure')).toEqual([]);
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

  it('reads timestamps in their common shapes', () => {
    expect(tokenize('2026-10-08 12:00:00,5 x')[0]).toEqual(['2026-10-08 12:00:00,5', 'number']);
    expect(tokenize('2026-10-08T12:00:00+02:00 x')[0]).toEqual([
      '2026-10-08T12:00:00+02:00',
      'number',
    ]);
    expect(tokenize('12:34:56.789 x')[0]).toEqual(['12:34:56.789', 'number']);
    expect(tokenize('Oct  8 12:00:01 host sshd')[0]).toEqual(['Oct  8 12:00:01', 'number']);
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
    expect(tokenize("don't panic at 5")).toEqual([
      ['panic', 'log-error'],
      ['5', 'number'],
    ]);
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
