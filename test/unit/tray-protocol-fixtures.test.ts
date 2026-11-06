import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeHelperLine, LineDecoder, parseHelperLine } from '../../server/tray/framing';
import { type SupervisorToHelper, TRAY_LIMITS } from '../../src/contracts/tray-protocol';

interface Fixture {
  dir: 'toHelper' | 'fromHelper';
  valid: boolean;
  line: string;
}

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'tray-protocol');
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    name: f,
    ...(JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf8')) as Fixture),
  }));

describe('tray protocol fixtures', () => {
  it('the fixture set is present', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(17);
  });

  for (const f of fixtures.filter((x) => x.dir === 'fromHelper')) {
    it(`fromHelper ${f.name} ${f.valid ? 'parses' : 'is rejected'}`, () => {
      const parsed = parseHelperLine(f.line);
      if (!f.valid) {
        expect(parsed).toBeInstanceOf(Error);
        return;
      }
      expect(parsed).not.toBeInstanceOf(Error);
      if (f.name === 'unknown-type.json') expect(parsed).toEqual({ type: 'unknown', raw: f.line });
      else expect(parsed).toEqual(JSON.parse(f.line));
    });
  }

  for (const f of fixtures.filter((x) => x.dir === 'toHelper')) {
    it(`toHelper ${f.name} round-trips through encodeHelperLine`, () => {
      const message = JSON.parse(f.line) as SupervisorToHelper;
      const line = encodeHelperLine(message);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1).includes('\n')).toBe(false);
      expect(JSON.parse(line)).toEqual(message);
    });
  }
});

describe('parseHelperLine field checks', () => {
  it.each([
    ['not json', '{'],
    ['not an object', '[1]'],
    ['no type', '{"x":1}'],
    ['hello without pid', '{"type":"hello","v":1,"helperVersion":"x"}'],
    ['openFailed without reason', '{"type":"openFailed"}'],
    ['log with a bad level', '{"type":"log","level":"debug","message":"m"}'],
  ])('%s is an Error', (_label, line) => {
    expect(parseHelperLine(line)).toBeInstanceOf(Error);
  });

  it('drops extra fields from a known message', () => {
    expect(parseHelperLine('{"type":"shown","extra":1}')).toEqual({ type: 'shown' });
  });
});

describe('LineDecoder', () => {
  it('splits lines across chunks, including a multi-byte char split mid-sequence', () => {
    const d = new LineDecoder(TRAY_LIMITS.maxLineBytes);
    const bytes = Buffer.from('{"a":"é"}\r\n{"b":2}\n{"c"', 'utf8');
    const cut = bytes.indexOf(0xa9);
    expect(d.push(bytes.subarray(0, cut))).toEqual({ lines: [], error: null });
    expect(d.push(bytes.subarray(cut))).toEqual({
      lines: ['{"a":"é"}', '{"b":2}'],
      error: null,
    });
    expect(d.push(Buffer.from(':3}\n'))).toEqual({ lines: ['{"c":3}'], error: null });
  });

  it('a line of exactly the limit passes; one byte more is a protocol error, and stays one', () => {
    const ok = new LineDecoder(8);
    expect(ok.push(Buffer.from('12345678\n'))).toEqual({ lines: ['12345678'], error: null });
    const bad = new LineDecoder(8);
    expect(bad.push(Buffer.from('123456789')).error).toBeInstanceOf(Error);
    expect(bad.push(Buffer.from('\n{}\n')).error).toBeInstanceOf(Error);
  });

  it('an oversize line built in-test at the real limit is rejected before its newline', () => {
    const d = new LineDecoder(TRAY_LIMITS.maxLineBytes);
    const r = d.push(Buffer.from(`{"type":"log","level":"info","message":"${'x'.repeat(70_000)}`));
    expect(r.error?.message).toMatch(/65536/);
  });

  it('truncate mode keeps the first bytes of an oversize line and resumes after it', () => {
    const d = new LineDecoder(4, 'truncate');
    expect(d.push(Buffer.from('abcdefgh\nij\n'))).toEqual({ lines: ['abcd', 'ij'], error: null });
  });
});

describe('encodeHelperLine', () => {
  it('refuses a line over the limit', () => {
    const view = {
      visible: true,
      icon: 'normal' as const,
      tooltip: 'x'.repeat(70_000),
      items: [],
      confirm: { title: '', body: '', confirm: '', cancel: '' },
      openFailed: { title: '', body: '' },
    };
    expect(() => encodeHelperLine({ type: 'view', view })).toThrow(RangeError);
  });
});
