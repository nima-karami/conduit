import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCommand } from '../../src/shells';

// The PATH walk probes the real (host) file system, so the dir is joined natively; the platform
// argument only picks the extension probe, which is what these cases pin.
let dir: string;
let savedPath: string | undefined;

const touch = (name: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  return p;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-command-'));
  savedPath = process.env.PATH;
  process.env.PATH = dir;
});

afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveCommand', () => {
  it('win32 bare name prefers .exe over .cmd', () => {
    touch('claude.cmd');
    const exe = touch('claude.exe');
    expect(resolveCommand('claude', 'win32')).toBe(exe);
  });

  it('win32 only .cmd present → the .cmd', () => {
    const cmd = touch('claude.cmd');
    expect(resolveCommand('claude', 'win32')).toBe(cmd);
  });

  it('absolute existing path → itself', () => {
    const p = touch('claude.bat');
    expect(resolveCommand(p, 'win32')).toBe(p);
  });

  it('not found → undefined', () => {
    touch('claude.cmd');
    expect(resolveCommand('codex', 'win32')).toBeUndefined();
    expect(resolveCommand(path.join(dir, 'gone.exe'), 'win32')).toBeUndefined();
  });
});
