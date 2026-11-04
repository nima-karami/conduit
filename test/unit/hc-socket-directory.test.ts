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
    const io = {
      mkdir: (_p: string, options: { mode: number }) => {
        mode = options.mode;
      },
      lstat: () => ({ ...stat, mode }),
    };
    ensureHcSocketDirectory(names, io, 501);
    expect(mode).toBe(0o700);
  });

  it.each([
    { label: 'symlink', changes: { isSymbolicLink: () => true } },
    { label: 'another owner', changes: { uid: 502 } },
    { label: 'group access', changes: { mode: 0o40750 } },
    { label: 'public access', changes: { mode: 0o40707 } },
    { label: 'regular file', changes: { isDirectory: () => false } },
  ])('refuses $label', ({ changes }) => {
    expect(() =>
      ensureHcSocketDirectory(
        names,
        {
          mkdir: () => undefined,
          lstat: () => ({ ...stat, ...changes }),
        },
        501,
      ),
    ).toThrow(/unsafe hc socket directory/i);
  });

  it('does no filesystem work when no override is needed (including Windows)', () => {
    const unexpected = () => {
      throw new Error('unexpected filesystem access');
    };
    ensureHcSocketDirectory({}, { mkdir: unexpected, lstat: unexpected }, 501);
  });

  it('surfaces a directory creation failure', () => {
    expect(() =>
      ensureHcSocketDirectory(
        names,
        {
          mkdir: () => {
            throw new Error('permission denied');
          },
          lstat: () => stat,
        },
        501,
      ),
    ).toThrow('permission denied');
  });
});
