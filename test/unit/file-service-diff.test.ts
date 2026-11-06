import fs, { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readDiff, readDiffReply } from '../../src/file-service';

const MB = 1024 * 1024;

describe('readDiff oversize cap', () => {
  it('refuses a >25MB work-side image without reading it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'));
    const p = join(dir, 'huge.png');
    writeFileSync(p, '');
    truncateSync(p, 26 * MB);
    const read = vi.spyOn(fs.promises, 'readFile');
    try {
      const dto = await readDiff(
        p,
        async () => '',
        async () => null,
      );
      expect(dto.image?.overCap).toBe(true);
      expect(dto.binary).toBe(true);
      expect(read).not.toHaveBeenCalledWith(p);
    } finally {
      read.mockRestore();
    }
  });

  it('marks a >2MB working file oversize instead of shipping its content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'));
    const p = join(dir, 'big.txt');
    writeFileSync(p, 'x'.repeat(2 * MB + 10));
    const dto = await readDiff(
      p,
      async () => '',
      async () => null,
    );
    expect(dto.oversize?.bytes).toBeGreaterThan(2 * MB);
    expect(dto.work).toBe('');
    expect(dto.head).toBe('');
  });

  it('marks oversize when the HEAD side exceeds the cap (a file that shrank)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'));
    const p = join(dir, 'small.txt');
    writeFileSync(p, 'now tiny\n');
    const hugeHead = 'y'.repeat(2 * MB + 10);
    const dto = await readDiff(
      p,
      async () => hugeHead,
      async () => null,
    );
    expect(dto.oversize?.bytes).toBeGreaterThan(2 * MB);
  });

  it('leaves a normal small file un-flagged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'));
    const p = join(dir, 'ok.txt');
    writeFileSync(p, 'line1\nline2\n');
    const dto = await readDiff(
      p,
      async () => 'line1\n',
      async () => null,
    );
    expect(dto.oversize).toBeUndefined();
    expect(dto.work).toContain('line2');
  });
});

describe('readDiffReply', () => {
  it('maps a thrown read to an error DTO', async () => {
    const dto = await readDiffReply(
      '/r/a.ts',
      () => {
        throw new Error('boom');
      },
      undefined,
      {},
    );
    expect(dto).toEqual({ path: '/r/a.ts', head: '', work: '', binary: false, error: 'boom' });
  });

  it('passes a normal read through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'));
    const p = join(dir, 'ok.txt');
    writeFileSync(p, 'line1\nline2\n');
    const gitShow = async () => 'line1\n';
    const scope = { base: 'index' as const, side: 'worktree' as const };
    expect(await readDiffReply(p, gitShow, undefined, scope)).toEqual(
      await readDiff(p, gitShow, undefined, scope),
    );
  });
});
