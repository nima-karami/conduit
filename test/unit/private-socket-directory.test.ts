import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePrivateSocketDirectory } from '../../src/private-socket-directory';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'conduit-private-dir-'));
  roots.push(root);
  return root;
}

const ownUid = process.getuid?.() ?? 0;
const mode = (path: string) => fs.statSync(path).mode & 0o777;

describe('ensurePrivateSocketDirectory', () => {
  it('creates a missing directory mode 0700 that this user owns', async () => {
    const dir = join(await scratch(), 'conduit-link-1000');
    ensurePrivateSocketDirectory(dir, 'link socket directory');
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  it('repairs an existing directory with a wrong mode', async () => {
    const dir = join(await scratch(), 'conduit-link-1000');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    ensurePrivateSocketDirectory(dir, 'link socket directory');
    expect(mode(dir)).toBe(0o700);
  });

  it('refuses an existing directory owned by another uid', async () => {
    const dir = join(await scratch(), 'conduit-link-1000');
    fs.mkdirSync(dir, { mode: 0o700 });
    expect(() =>
      ensurePrivateSocketDirectory(dir, 'link socket directory', undefined, ownUid + 1),
    ).toThrow(/unsafe link socket directory/i);
  });

  it('refuses a symlink in place of the directory', async () => {
    const root = await scratch();
    const real = join(root, 'real');
    const dir = join(root, 'conduit-link-1000');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, dir);
    expect(() => ensurePrivateSocketDirectory(dir, 'link socket directory')).toThrow(
      /unsafe link socket directory/i,
    );
  });
});
