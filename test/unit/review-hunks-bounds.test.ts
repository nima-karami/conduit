import { describe, expect, it } from 'vitest';
import {
  computeFileReview,
  computeReplacementEmphasis,
  EMPHASIS_MAX_LINES,
  MAX_LCS_CELLS,
  type ReviewLine,
} from '../../src/review-hunks';

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}-${i}`).join('\n');

describe('bounded diffLines', () => {
  it('big file with a small mid-file edit diffs EXACTLY via prefix/suffix trim', () => {
    const n = 30000;
    const head = lines(n, 'x');
    const work = head.replace('x-15000', 'EDITED');
    const r = computeFileReview(head, work);
    expect(r.approx).toBeUndefined();
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.hunks).toHaveLength(1);
  });

  it('two unrelated large sides degrade to an approx whole-replacement, not a quadratic alloc', () => {
    const n = 8000; // 8000*8000 = 64M cells > MAX_LCS_CELLS — would be ~512MB dense
    const r = computeFileReview(lines(n, 'a'), lines(n, 'b'));
    expect(r.approx).toBe(true);
    expect(r.added).toBe(n);
    expect(r.removed).toBe(n);
  });

  it('trim handles pure-append and pure-truncate without approx', () => {
    const head = lines(20000, 'x');
    const r = computeFileReview(head, `${head}\nnew-1\nnew-2`);
    expect(r.approx).toBeUndefined();
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);

    const t = computeFileReview(head, lines(19998, 'x'));
    expect(t.approx).toBeUndefined();
    expect(t.added).toBe(0);
    expect(t.removed).toBe(2);
  });

  it('identical sides stay a no-op regardless of size', () => {
    const head = lines(50000, 'x');
    const r = computeFileReview(head, head);
    expect(r.hunks).toHaveLength(0);
    expect(r.approx).toBeUndefined();
  });

  it('small files behave exactly as before (budget invisible)', () => {
    const r = computeFileReview('a\nb\nc', 'a\nX\nc');
    expect(r.approx).toBeUndefined();
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('cell budget is the documented constant', () => {
    expect(MAX_LCS_CELLS).toBe(4_000_000);
  });

  it('approx line numbers stay consistent with the trimmed prefix', () => {
    const prefix = lines(10, 'p');
    const head = `${prefix}\n${lines(3000, 'a')}`;
    const work = `${prefix}\n${lines(3000, 'b')}`;
    const r = computeFileReview(head, work);
    expect(r.approx).toBe(true);
    const all = r.hunks.flatMap((h) => h.lines);
    const firstDel = all.find((l) => l.kind === 'del');
    const firstAdd = all.find((l) => l.kind === 'add');
    expect(firstDel?.oldLine).toBe(11);
    expect(firstAdd?.newLine).toBe(11);
  });
});

describe('computeReplacementEmphasis bounds', () => {
  it('bails on a giant hunk', () => {
    const mk = (kind: 'del' | 'add', i: number): ReviewLine => ({
      kind,
      text: `t${i}`,
      oldLine: kind === 'del' ? i + 1 : null,
      newLine: kind === 'add' ? i + 1 : null,
      seq: i,
    });
    const big: ReviewLine[] = [
      ...Array.from({ length: EMPHASIS_MAX_LINES / 2 + 1 }, (_, i) => mk('del', i)),
      ...Array.from({ length: EMPHASIS_MAX_LINES / 2 + 1 }, (_, i) => mk('add', i + 100000)),
    ];
    expect(computeReplacementEmphasis(big).size).toBe(0);
  });

  it('emphasis limit is the documented constant', () => {
    expect(EMPHASIS_MAX_LINES).toBe(4000);
  });
});
