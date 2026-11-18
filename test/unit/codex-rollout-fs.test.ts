import { execFileSync } from 'node:child_process';
import { appendFileSync, promises as fsp, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRolloutFs, type RolloutReadEvent } from '../../server/domain/codex-rollout-fs';
import { tempRoots } from '../helpers/temp-roots';

const roots = tempRoots('rollout-fs-');

async function events(
  fs: ReturnType<typeof createRolloutFs>,
  file: string,
  offset: number,
  discard = false,
): Promise<RolloutReadEvent[]> {
  const result: RolloutReadEvent[] = [];
  for await (const event of fs.readFrom(file, offset, discard)) result.push(event);
  return result;
}

describe('createRolloutFs', () => {
  it('preserves partial records and UTF-8 across chunks and notifications', async () => {
    const file = join(roots.root(), 'r.jsonl');
    writeFileSync(file, 'one\ncafé 😀');
    const fs = createRolloutFs({ onFirstLineTooLong: () => {}, chunkBytes: 3 });
    expect((await events(fs, file, 0)).slice(1)).toEqual([
      { kind: 'lines', lines: ['one'], cursor: 4, discarding: false },
      { kind: 'end', cursor: 4, discarding: false },
    ]);
    appendFileSync(file, '\n');
    const end = Buffer.byteLength('one\ncafé 😀\n');
    expect((await events(fs, file, 4)).slice(1)).toEqual([
      { kind: 'lines', lines: ['café 😀'], cursor: end, discarding: false },
      { kind: 'end', cursor: end, discarding: false },
    ]);
  });

  it('skips oversized records across high-water marks and resumes after newline', async () => {
    const file = join(roots.root(), 'r.jsonl');
    writeFileSync(file, 'abcdef');
    const fs = createRolloutFs({ onFirstLineTooLong: () => {}, recordMaxBytes: 4, chunkBytes: 3 });
    const first = await events(fs, file, 0);
    expect(first.slice(1)).toEqual([
      { kind: 'gap', cursor: 6, discarding: true },
      { kind: 'end', cursor: 6, discarding: true },
    ]);
    appendFileSync(file, 'gh\nok\n');
    expect((await events(fs, file, 6, true)).slice(1)).toEqual([
      { kind: 'gap', cursor: 9, discarding: false },
      { kind: 'lines', lines: ['ok'], cursor: 12, discarding: false },
      { kind: 'end', cursor: 12, discarding: false },
    ]);
  });

  it('fixes the high-water mark before later appends', async () => {
    const file = join(roots.root(), 'r.jsonl');
    writeFileSync(file, 'one\n');
    const fs = createRolloutFs({ onFirstLineTooLong: () => {} });
    const iterator = fs.readFrom(file, 0)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: 'start', highWater: 4 });
    appendFileSync(file, 'two\n');
    expect((await iterator.next()).value).toMatchObject({ kind: 'lines', lines: ['one'] });
    expect((await iterator.next()).value).toMatchObject({ kind: 'end', cursor: 4 });
    await iterator.return?.();
  });

  it('handles a sparse oversized tail with bounded records', async () => {
    const file = join(roots.root(), 'r.jsonl');
    writeFileSync(file, '');
    truncateSync(file, 2 * 1024 * 1024);
    const fs = createRolloutFs({ onFirstLineTooLong: () => {} });
    const alloc = vi.spyOn(Buffer, 'alloc');
    const result = await events(fs, file, 0);
    expect(Math.max(...alloc.mock.calls.map(([size]) => size))).toBeLessThanOrEqual(64 * 1024);
    alloc.mockRestore();
    expect(result.at(-1)).toEqual({ kind: 'end', cursor: 2 * 1024 * 1024, discarding: true });
    expect(result.some((e) => e.kind === 'lines')).toBe(false);
  });

  it('closes the descriptor when an iteration is cancelled', async () => {
    const file = join(roots.root(), 'r.jsonl');
    writeFileSync(file, 'one\n');
    const open = fsp.open.bind(fsp);
    let close: ReturnType<typeof vi.spyOn> | undefined;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      close = vi.spyOn(handle, 'close');
      return handle;
    });
    try {
      const fs = createRolloutFs({ onFirstLineTooLong: () => {} });
      const iterator = fs.readFrom(file, 0)[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      openSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      const file = join(roots.root(), 'fifo');
      execFileSync('mkfifo', [file]);
      const fs = createRolloutFs({ onFirstLineTooLong: () => {} });
      expect(await fs.readFirstLine(file)).toBeNull();
      await expect(events(fs, file, 0)).rejects.toThrow('invalid rollout file');
    },
  );

  it('caps first-line metadata and leaves incomplete metadata unread', async () => {
    const file = join(roots.root(), 'r.jsonl');
    const tooLong: string[] = [];
    const fs = createRolloutFs({
      onFirstLineTooLong: (f) => tooLong.push(f),
      firstLineMaxBytes: 4,
    });
    writeFileSync(file, 'abc');
    expect(await fs.readFirstLine(file)).toBeNull();
    writeFileSync(file, 'abc\n');
    expect(await fs.readFirstLine(file)).toBe('abc');
    writeFileSync(file, 'abcd\n');
    expect(await fs.readFirstLine(file)).toBeNull();
    expect(tooLong).toEqual([file]);
  });
});
