import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteFile, atomicWriteFileSync } from '../../src/atomic-write';

const trees: string[] = [];
afterEach(() => {
  for (const dir of trees.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const scratch = join(tmpdir(), 'Codex-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'atomicw-'));
  trees.push(dir);
  return dir;
}

describe('atomicWriteFile', () => {
  it('persists the newest concurrent snapshot and completes every callback without collisions', async () => {
    const dir = tmp();
    const file = join(dir, 'state.json');
    const errors = await Promise.all(
      Array.from(
        { length: 40 },
        (_, seq) =>
          new Promise<NodeJS.ErrnoException | null>((resolve) => {
            atomicWriteFile(file, JSON.stringify({ seq, payload: 'x'.repeat(10000) }), resolve);
          }),
      ),
    );
    expect(errors).toEqual(Array(40).fill(null));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).seq).toBe(39);
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('a synchronous final snapshot supersedes active and queued async writes', async () => {
    const dir = tmp();
    const file = join(dir, 'state.json');
    const first = new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'old', resolve),
    );
    const second = new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'queued', resolve),
    );
    atomicWriteFileSync(file, 'final');
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(fs.readFileSync(file, 'utf8')).toBe('final');
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('allows a new async write after a synchronous snapshot invalidates earlier work', async () => {
    const dir = tmp();
    const file = join(dir, 'state.json');
    const old = new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'old', resolve),
    );
    atomicWriteFileSync(file, 'final');
    const newer = new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'newer', resolve),
    );
    expect(await Promise.all([old, newer])).toEqual([null, null]);
    expect(fs.readFileSync(file, 'utf8')).toBe('newer');
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('can retry after an async write fails without retaining a temp file', async () => {
    const dir = tmp();
    const parent = join(dir, 'missing');
    const file = join(parent, 'state.json');
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'failed', resolve),
    );
    expect(error?.code).toBe('ENOENT');
    fs.mkdirSync(parent);
    const retried = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'recovered', resolve),
    );
    expect(retried).toBe(null);
    expect(fs.readFileSync(file, 'utf8')).toBe('recovered');
    expect(fs.readdirSync(parent)).toEqual(['state.json']);
  });

  it('a failed sync promotion does not discard queued async snapshots', async () => {
    const file = join(tmp(), 'state.json');
    const old = new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'old', resolve),
    );
    const newer = new Promise<NodeJS.ErrnoException | null>((resolve) =>
      atomicWriteFile(file, 'newer', resolve),
    );
    expect(() =>
      atomicWriteFileSync(file, 'failed', {
        writeFileSync: fs.writeFileSync,
        unlinkSync: fs.unlinkSync,
        renameSync: () => {
          throw new Error('promotion failed');
        },
      }),
    ).toThrow('promotion failed');
    expect(await Promise.all([old, newer])).toEqual([null, null]);
    expect(fs.readFileSync(file, 'utf8')).toBe('newer');
  });
});

describe('atomicWriteFileSync', () => {
  it('writes content to a new path', () => {
    const f = join(tmp(), 'a.json');
    atomicWriteFileSync(f, '{"x":1}');
    expect(fs.readFileSync(f, 'utf8')).toBe('{"x":1}');
  });

  it('overwrites an existing file', () => {
    const f = join(tmp(), 'a.json');
    fs.writeFileSync(f, 'OLD');
    atomicWriteFileSync(f, 'NEW');
    expect(fs.readFileSync(f, 'utf8')).toBe('NEW');
  });

  it('writes a Buffer byte-for-byte, invalid UTF-8 included', () => {
    const f = join(tmp(), 'projects.corrupt.json');
    const bytes = Buffer.from([0x7b, 0x22, 0xe2, 0x82, 0xff, 0xc0, 0x00, 0x80]);
    atomicWriteFileSync(f, bytes);
    expect(fs.readFileSync(f).equals(bytes)).toBe(true);
  });

  it('leaves no temp sibling behind on success', () => {
    const dir = tmp();
    const f = join(dir, 'a.json');
    atomicWriteFileSync(f, 'data');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('preserves the existing file if the rename fails (no truncation)', () => {
    const dir = tmp();
    const f = join(dir, 'a.json');
    fs.writeFileSync(f, 'OLD');
    // A plain fs.writeFile(f, …) truncates `f` BEFORE writing — so an interrupted write
    // would leave it empty. The atomic write must keep the old content intact instead.
    // Inject an fs whose rename throws (the real renameSync can't be spied on under ESM).
    const io = {
      writeFileSync: fs.writeFileSync,
      unlinkSync: fs.unlinkSync,
      renameSync: () => {
        throw new Error('boom');
      },
    } as unknown as Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'unlinkSync'>;
    expect(() => atomicWriteFileSync(f, 'NEW', io)).toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe('OLD');
    // and the temp file is cleaned up, not orphaned
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });
});
