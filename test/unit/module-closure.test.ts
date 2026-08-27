import { describe, expect, it } from 'vitest';
import {
  boundFiles,
  CLOSURE_BYTE_CAP,
  CLOSURE_FILE_CAP,
  CLOSURE_MAX_FILE_BYTES,
} from '../../src/module-resolver-fs';

const reader = (sizes: Record<string, number>) => (p: string) =>
  sizes[p] === undefined ? null : { content: '', bytes: sizes[p] };

describe('closure bounds', () => {
  it('caps the file count', () => {
    const ordered = Array.from({ length: 500 }, (_, i) => `g:/p/n/${i}.d.ts`);
    const sizes = Object.fromEntries(ordered.map((p) => [p, 10]));
    expect(boundFiles(ordered, reader(sizes))).toHaveLength(CLOSURE_FILE_CAP);
  });

  it('stops at the byte budget even under the file cap', () => {
    const ordered = Array.from({ length: 10 }, (_, i) => `g:/p/n/${i}.d.ts`);
    const each = Math.floor(CLOSURE_BYTE_CAP / 3);
    const sizes = Object.fromEntries(ordered.map((p) => [p, each]));
    expect(boundFiles(ordered, reader(sizes)).length).toBeLessThanOrEqual(3);
  });

  it('skips an oversize file instead of truncating it — row 17', () => {
    const ordered = ['g:/p/n/big.d.ts', 'g:/p/n/small.d.ts'];
    const files = boundFiles(
      ordered,
      reader({ 'g:/p/n/big.d.ts': CLOSURE_MAX_FILE_BYTES + 1, 'g:/p/n/small.d.ts': 10 }),
    );
    expect(files.map((f) => f.path)).toEqual(['g:/p/n/small.d.ts']);
  });

  it('drops unreadable entries without failing the batch', () => {
    expect(
      boundFiles(['g:/p/n/gone.d.ts', 'g:/p/n/ok.d.ts'], reader({ 'g:/p/n/ok.d.ts': 5 })),
    ).toHaveLength(1);
  });

  it('always keeps the first file when it fits — the entry must never be dropped', () => {
    expect(boundFiles(['g:/p/n/entry.d.ts'], reader({ 'g:/p/n/entry.d.ts': 10 }))[0]?.path).toBe(
      'g:/p/n/entry.d.ts',
    );
  });

  it('keeps a file sitting exactly on the per-file cap', () => {
    const files = boundFiles(
      ['g:/p/n/entry.d.ts'],
      reader({ 'g:/p/n/entry.d.ts': CLOSURE_MAX_FILE_BYTES }),
    );
    expect(files).toHaveLength(1);
  });

  it('preserves the given order — the entry leads', () => {
    const ordered = ['g:/p/n/entry.d.ts', 'g:/p/n/leaf.d.ts'];
    const files = boundFiles(ordered, reader({ 'g:/p/n/entry.d.ts': 5, 'g:/p/n/leaf.d.ts': 5 }));
    expect(files.map((f) => f.path)).toEqual(ordered);
  });
});
