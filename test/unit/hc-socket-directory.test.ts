import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureHcSocketDirectory } from '../../src/instance-names';

describe('hc socket directory', () => {
  const names = { hcSocket: '/private/conduit-hc/12345678.sock' };
  const stat = {
    uid: 501,
    mode: 0o40700,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };

  it('creates the socket parent before use, with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conduit-hc-dir-'));
    try {
      const directory = join(root, 'private');
      const socket = join(directory, '12345678.sock').replaceAll('\\', '/');
      ensureHcSocketDirectory(
        { hcSocket: socket },
        {
          mkdir: fs.mkdirSync,
          chmod: fs.chmodSync,
          lstat: (p) => {
            const found = fs.lstatSync(p);
            return {
              ...stat,
              isDirectory: () => found.isDirectory(),
              isSymbolicLink: () => found.isSymbolicLink(),
            };
          },
        },
        501,
      );
      expect(fs.lstatSync(directory).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requests mode 0700 and accepts an existing private directory owned by this user', () => {
    let mode = 0;
    const creates: { path: string; options: { recursive?: boolean; mode?: number } }[] = [];
    const io = {
      mkdir: (path: string, options: { recursive?: boolean; mode?: number }) => {
        creates.push({ path, options });
        if (options.mode !== undefined) mode = options.mode;
      },
      chmod: (_p: string, value: number) => {
        mode = value;
      },
      lstat: () => ({ ...stat, mode }),
    };
    ensureHcSocketDirectory(names, io, 501);
    expect(mode).toBe(0o700);
    expect(creates).toEqual([
      { path: '/private', options: { recursive: true } },
      { path: '/private/conduit-hc', options: { mode: 0o700 } },
    ]);
  });

  it.each([
    { label: 'symlink', changes: { isSymbolicLink: () => true } },
    { label: 'another owner', changes: { uid: 502 } },
    { label: 'regular file', changes: { isDirectory: () => false } },
  ])('refuses $label', ({ changes }) => {
    expect(() =>
      ensureHcSocketDirectory(
        names,
        {
          mkdir: () => undefined,
          chmod: () => {
            throw new Error('must not chmod an unsafe directory');
          },
          lstat: () => ({ ...stat, ...changes }),
        },
        501,
      ),
    ).toThrow(/unsafe hc socket directory/i);
  });

  it.each([0o40750, 0o40707])('repairs an owned real directory with mode %o', (mode) => {
    let permissions = mode;
    ensureHcSocketDirectory(
      names,
      {
        mkdir: (_path, options) => {
          if (options.mode !== undefined)
            throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        },
        lstat: () => ({ ...stat, mode: permissions }),
        chmod: (_path, value) => {
          permissions = value;
        },
      },
      501,
    );
    expect(permissions).toBe(0o700);
  });

  it('does no filesystem work when no override is needed (including Windows)', () => {
    const unexpected = () => {
      throw new Error('unexpected filesystem access');
    };
    ensureHcSocketDirectory({}, { mkdir: unexpected, lstat: unexpected, chmod: unexpected }, 501);
  });

  it('refuses unresolved endpoints before any filesystem work', () => {
    const unexpected = () => {
      throw new Error('unexpected filesystem access');
    };
    expect(() =>
      ensureHcSocketDirectory(
        { hcEndpointError: 'invalid hc config' },
        {
          mkdir: unexpected,
          lstat: unexpected,
          chmod: unexpected,
        },
        501,
      ),
    ).toThrow('invalid hc config');
  });

  it('surfaces a directory creation failure', () => {
    expect(() =>
      ensureHcSocketDirectory(
        names,
        {
          mkdir: () => {
            throw new Error('permission denied');
          },
          chmod: () => {},
          lstat: () => stat,
        },
        501,
      ),
    ).toThrow('permission denied');
  });
});
