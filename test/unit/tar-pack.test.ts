import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestOf, packTree } from '../../src/network/tar-pack';

const posix = process.platform !== 'win32';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tar-pack-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Unpacks a packed stream with the system tar, as the remote does, and returns the target dir. */
function unpack(archive: Buffer): string {
  const file = join(dir, 'stream.tar');
  writeFileSync(file, archive);
  const target = join(dir, 'out');
  mkdirSync(target);
  execFileSync('tar', ['-xf', file, '-C', target]);
  return target;
}

/** The 512-byte header of the entry at `offset`, with its stored checksum and recomputed one. */
function checksums(archive: Buffer, offset: number): { stored: number; computed: number } {
  const header = Buffer.from(archive.subarray(offset, offset + 512));
  const stored = parseInt(header.subarray(148, 154).toString('ascii'), 8);
  header.fill(0x20, 148, 156);
  let computed = 0;
  for (const byte of header) computed += byte;
  return { stored, computed };
}

describe('packTree', () => {
  it.skipIf(!posix)('unpacks with the system tar to identical bytes and modes', () => {
    const files = [
      { path: 'main.js', data: Buffer.from('console.log(1)\n'), mode: 0o644 },
      { path: 'bin/run.sh', data: Buffer.from('#!/bin/sh\necho run\n'), mode: 0o755 },
      { path: 'lib/deep/a.bin', data: Buffer.from([0, 1, 2, 255, 254]), mode: 0o600 },
    ];
    const target = unpack(packTree(files));
    for (const f of files) {
      const abs = join(target, f.path);
      expect(readFileSync(abs).equals(f.data)).toBe(true);
      expect(statSync(abs).mode & 0o777).toBe(f.mode);
    }
  });

  it.skipIf(!posix)(
    'packs and unpacks a path longer than 100 bytes through the ustar prefix',
    () => {
      const long = `${'segment-'.repeat(8)}/${'nested-'.repeat(6)}/file.js`;
      expect(Buffer.byteLength(long)).toBeGreaterThan(100);
      const target = unpack(packTree([{ path: long, data: Buffer.from('x'), mode: 0o644 }]));
      expect(readFileSync(join(target, long), 'utf8')).toBe('x');
    },
  );

  it.skipIf(!posix)('round-trips a non-ASCII path', () => {
    const name = 'lib/héllo-世界.js';
    const target = unpack(packTree([{ path: name, data: Buffer.from('ok'), mode: 0o644 }]));
    expect(readFileSync(join(target, name), 'utf8')).toBe('ok');
  });

  it('packs to whole 512-byte blocks ending in two zero blocks', () => {
    const archive = packTree([{ path: 'a', data: Buffer.alloc(513, 7), mode: 0o644 }]);
    expect(archive.length % 512).toBe(0);
    expect(archive.subarray(archive.length - 1024).every((b) => b === 0)).toBe(true);
    // header + 2 data blocks (513 bytes pads to 1024) + 2 end blocks
    expect(archive.length).toBe(512 + 1024 + 1024);
  });

  it('writes each header checksum that tar will verify', () => {
    const archive = packTree([
      { path: 'a.js', data: Buffer.from('a'), mode: 0o644 },
      { path: 'dir/b.js', data: Buffer.from('bb'), mode: 0o755 },
    ]);
    const first = checksums(archive, 0);
    expect(first.stored).toBe(first.computed);
    const second = checksums(archive, 1024);
    expect(second.stored).toBe(second.computed);
  });

  it('packs an empty list to two zero blocks', () => {
    const archive = packTree([]);
    expect(archive.length).toBe(1024);
    expect(archive.every((b) => b === 0)).toBe(true);
  });

  it.each([
    ['a .. segment', '../escape.js'],
    ['an inner .. segment', 'a/../../escape.js'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'lib\\x.js'],
    ['an empty segment', 'a//b.js'],
    ['a trailing slash', 'a/'],
    ['an empty path', ''],
    ['a NUL', 'a\0b.js'],
  ])('throws on %s', (_label, path) => {
    expect(() => packTree([{ path, data: Buffer.from('x'), mode: 0o644 }])).toThrow();
  });

  it('throws on a path that ustar cannot hold (no split leaves name and prefix in range)', () => {
    const path = 'x'.repeat(300);
    expect(() => packTree([{ path, data: Buffer.from('x'), mode: 0o644 }])).toThrow();
  });

  it('throws on a duplicate path', () => {
    expect(() =>
      packTree([
        { path: 'a.js', data: Buffer.from('1'), mode: 0o644 },
        { path: 'a.js', data: Buffer.from('2'), mode: 0o644 },
      ]),
    ).toThrow();
  });
});

describe('manifestOf', () => {
  it('gives each file its sha256 and size, in order', () => {
    const data = Buffer.from('hello world');
    const manifest = manifestOf([
      { path: 'a.txt', data, mode: 0o644 },
      { path: 'b/c.txt', data: Buffer.alloc(0), mode: 0o644 },
    ]);
    expect(manifest).toEqual([
      {
        path: 'a.txt',
        sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
        size: 11,
      },
      {
        path: 'b/c.txt',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size: 0,
      },
    ]);
  });
});
