import { describe, expect, it, vi } from 'vitest';
import { LineReader } from '../../src/line-reader';

function reader(max: number) {
  const lines: string[] = [];
  const overflow = vi.fn();
  return {
    lines,
    overflow,
    r: new LineReader(
      () => max,
      (l) => lines.push(l),
      overflow,
    ),
  };
}

describe('LineReader', () => {
  it('splits lines across and within chunks', () => {
    const { r, lines } = reader(100);
    r.write(Buffer.from('ab'));
    r.write(Buffer.from('c\nd\n\ne'));
    r.write(Buffer.from('f\n'));
    expect(lines).toEqual(['abc', 'd', '', 'ef']);
  });

  it('decodes a multi-byte character split across chunks', () => {
    const { r, lines } = reader(100);
    const bytes = Buffer.from('é\n');
    r.write(bytes.subarray(0, 1));
    r.write(bytes.subarray(1));
    expect(lines).toEqual(['é']);
  });

  it('refuses an unterminated line that outgrows the cap, and delivers nothing after', () => {
    const { r, lines, overflow } = reader(8);
    r.write(Buffer.from('12345'));
    r.write(Buffer.from('6789'));
    r.write(Buffer.from('x\nnext\n'));
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it('refuses a complete line over the cap', () => {
    const { r, lines, overflow } = reader(4);
    r.write(Buffer.from('ok\n123456\n'));
    expect(lines).toEqual(['ok']);
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it('stops delivering when told to', () => {
    const { r, lines } = reader(100);
    let n = 0;
    r.write(Buffer.from('a\nb\nc\n'), () => n++ < 1);
    expect(lines).toEqual(['a']);
  });

  it('assembles one big line from many small chunks', () => {
    const { r, lines } = reader(10 * 1024 * 1024);
    const piece = Buffer.alloc(1024, 'x');
    for (let i = 0; i < 4000; i++) r.write(piece);
    r.write(Buffer.from('\n'));
    expect(lines).toEqual(['x'.repeat(4000 * 1024)]);
  });
});
