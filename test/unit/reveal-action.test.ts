import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revealActionFor } from '../../src/reveal-action';

describe('revealActionFor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-action-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "openPath" for an existing directory', () => {
    expect(revealActionFor(tmpDir)).toBe('openPath');
  });

  it('returns "showItemInFolder" for an existing file', () => {
    const file = path.join(tmpDir, 'sample.txt');
    fs.writeFileSync(file, 'hello');
    expect(revealActionFor(file)).toBe('showItemInFolder');
  });

  it('returns "showItemInFolder" when the path does not exist (graceful fallback)', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(revealActionFor(missing)).toBe('showItemInFolder');
  });

  it('returns "showItemInFolder" for a nested file inside a directory', () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    const file = path.join(subDir, 'readme.md');
    fs.writeFileSync(file, '# hi');
    expect(revealActionFor(file)).toBe('showItemInFolder');
  });

  it('returns "openPath" for a nested sub-directory', () => {
    const subDir = path.join(tmpDir, 'nested');
    fs.mkdirSync(subDir);
    expect(revealActionFor(subDir)).toBe('openPath');
  });
});
