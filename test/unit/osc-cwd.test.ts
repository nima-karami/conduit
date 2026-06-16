import { describe, expect, it } from 'vitest';
import { CwdScanner, parseCwdReports } from '../../src/osc-cwd';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

/** Build an OSC sequence: ESC ] <body> <terminator> */
const osc = (body: string, term: string = BEL) => `${ESC}]${body}${term}`;

describe('parseCwdReports', () => {
  it('returns [] for a chunk with no OSC sequences', () => {
    expect(parseCwdReports('hello world')).toEqual([]);
  });

  it('returns [] for non-cwd OSC (e.g. OSC 0 title)', () => {
    expect(parseCwdReports(osc('0;My Title'))).toEqual([]);
  });

  // OSC 7 with BEL terminator
  it('parses OSC 7 with BEL terminator', () => {
    expect(parseCwdReports(osc('7;file:///home/user/projects', BEL))).toEqual([
      '/home/user/projects',
    ]);
  });

  it('parses OSC 7 with ESC-backslash terminator', () => {
    expect(parseCwdReports(osc('7;file:///home/user/projects', ST))).toEqual([
      '/home/user/projects',
    ]);
  });

  it('parses OSC 7 with percent-encoded spaces', () => {
    expect(parseCwdReports(osc('7;file:///home/user/my%20project', BEL))).toEqual([
      '/home/user/my project',
    ]);
  });

  it('parses OSC 7 Windows form file:///C:/...', () => {
    expect(parseCwdReports(osc('7;file:///C:/Users/test/projects', BEL))).toEqual([
      'C:/Users/test/projects',
    ]);
  });

  it('parses OSC 7 with hostname in URL', () => {
    expect(parseCwdReports(osc('7;file://localhost/home/user/work', BEL))).toEqual([
      '/home/user/work',
    ]);
  });

  // OSC 9;9 Windows Terminal style
  it('parses OSC 9;9 with BEL terminator', () => {
    expect(parseCwdReports(osc('9;9;C:/Users/nima/projects', BEL))).toEqual([
      'C:/Users/nima/projects',
    ]);
  });

  it('parses OSC 9;9 with ESC-backslash terminator', () => {
    expect(parseCwdReports(osc('9;9;C:/foo/bar', ST))).toEqual(['C:/foo/bar']);
  });

  it('normalizes backslashes in OSC 9;9', () => {
    expect(parseCwdReports(osc('9;9;C:\\Users\\nima\\work', BEL))).toEqual(['C:/Users/nima/work']);
  });

  // OSC 1337 iTerm2 style
  it('parses OSC 1337 CurrentDir with BEL terminator', () => {
    expect(parseCwdReports(osc('1337;CurrentDir=/usr/local/src', BEL))).toEqual(['/usr/local/src']);
  });

  it('parses OSC 1337 CurrentDir with ESC-backslash terminator', () => {
    expect(parseCwdReports(osc('1337;CurrentDir=/var/www', ST))).toEqual(['/var/www']);
  });

  // Multiple reports
  it('returns multiple cwd reports in order', () => {
    const chunk = `${osc('9;9;C:/foo', BEL)}some output in between${osc('7;file:///home/user/bar', BEL)}`;
    expect(parseCwdReports(chunk)).toEqual(['C:/foo', '/home/user/bar']);
  });

  it('mixed with non-cwd OSC: only cwd reports returned', () => {
    const chunk = `${osc('0;Terminal Title', BEL)}${osc('7;file:///tmp/work', BEL)}`;
    expect(parseCwdReports(chunk)).toEqual(['/tmp/work']);
  });
});

describe('CwdScanner', () => {
  it('returns null when no cwd in chunk', () => {
    const s = new CwdScanner();
    expect(s.push('ordinary output')).toBeNull();
  });

  it('returns cwd when a complete sequence is pushed', () => {
    const s = new CwdScanner();
    expect(s.push(osc('7;file:///home/user/work', BEL))).toBe('/home/user/work');
  });

  it('returns the last cwd when multiple in one push', () => {
    const s = new CwdScanner();
    const chunk = osc('9;9;C:/first', BEL) + osc('9;9;C:/second', BEL);
    expect(s.push(chunk)).toBe('C:/second');
  });

  it('handles sequence split across two pushes (OSC 9;9)', () => {
    const s = new CwdScanner();
    expect(s.push(`${ESC}]9;9;C:/fo`)).toBeNull();
    expect(s.push(`o${BEL}`)).toBe('C:/foo');
  });

  it('handles sequence split across two pushes (OSC 7)', () => {
    const s = new CwdScanner();
    expect(s.push(`${ESC}]7;file:///home/us`)).toBeNull();
    expect(s.push(`er/work${BEL}`)).toBe('/home/user/work');
  });

  it('handles sequence split at the terminator (ESC-backslash)', () => {
    const s = new CwdScanner();
    expect(s.push(`${ESC}]9;9;C:/bar${ESC}`)).toBeNull();
    expect(s.push('\\')).toBe('C:/bar');
  });

  it('returns null from second push when no completion yet', () => {
    const s = new CwdScanner();
    expect(s.push(`${ESC}]9;9;C:/work`)).toBeNull();
    expect(s.push(' more data without terminator')).toBeNull();
  });

  it('handles multiple split sequences across several pushes', () => {
    const s = new CwdScanner();
    s.push(`${ESC}]9;9;C:/alpha${BEL}`);
    expect(s.push(osc('9;9;C:/beta', BEL))).toBe('C:/beta');
  });

  it('does not return the same cwd twice on subsequent non-cwd pushes', () => {
    const s = new CwdScanner();
    s.push(osc('9;9;C:/project', BEL));
    // Next push has no cwd report
    expect(s.push('just some terminal output')).toBeNull();
  });

  it('handles Windows file:/// form correctly', () => {
    const s = new CwdScanner();
    expect(s.push(osc('7;file:///C:/Users/nima/projects', BEL))).toBe('C:/Users/nima/projects');
  });

  it('handles percent-decoded spaces in split sequence', () => {
    const s = new CwdScanner();
    s.push(`${ESC}]7;file:///home/user/my%20`);
    expect(s.push(`project${BEL}`)).toBe('/home/user/my project');
  });
});
