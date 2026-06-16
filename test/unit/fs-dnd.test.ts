import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fsCopy, fsMove } from '../../src/fs-dnd';
import { tempRoots } from '../helpers/temp-roots';

const { root, cleanup } = tempRoots('fsdnd-');
afterEach(cleanup);

const J = (...p: string[]) => path.join(...p);

describe('fsMove — guarded move against a real temp dir', () => {
  it('moves a file and removes the source', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'hello');
    const res = await fsMove(J(r, 'a.ts'), J(r, 'sub', 'a.ts'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(J(r, 'a.ts'))).toBe(false);
    expect(fs.readFileSync(J(r, 'sub', 'a.ts'), 'utf8')).toBe('hello');
  });

  it('moves a folder recursively', async () => {
    const r = root();
    fs.mkdirSync(J(r, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(J(r, 'src', 'utils', 'helper.ts'), 'export {}');
    const res = await fsMove(J(r, 'src'), J(r, 'lib'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(J(r, 'src'))).toBe(false);
    expect(fs.readFileSync(J(r, 'lib', 'utils', 'helper.ts'), 'utf8')).toBe('export {}');
  });

  it('creates intermediate parent directories', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'file.ts'), 'x');
    const res = await fsMove(J(r, 'file.ts'), J(r, 'a', 'b', 'c', 'file.ts'), [r]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(J(r, 'a', 'b', 'c', 'file.ts'))).toBe(true);
  });

  it('refuses when source is outside the workspace root', async () => {
    const r = root();
    const outside = root();
    fs.writeFileSync(J(outside, 'evil.ts'), 'x');
    const res = await fsMove(J(outside, 'evil.ts'), J(r, 'evil.ts'), [r]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/outside the workspace/i);
    // Source is untouched
    expect(fs.existsSync(J(outside, 'evil.ts'))).toBe(true);
  });

  it('refuses when destination is outside the workspace root', async () => {
    const r = root();
    const outside = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const res = await fsMove(J(r, 'a.ts'), J(outside, 'escaped.ts'), [r]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/outside the workspace/i);
    // Source still exists
    expect(fs.existsSync(J(r, 'a.ts'))).toBe(true);
  });

  it('refuses when destination already exists (no silent overwrite)', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'original');
    fs.writeFileSync(J(r, 'b.ts'), 'existing');
    const res = await fsMove(J(r, 'a.ts'), J(r, 'b.ts'), [r]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already exists/i);
    // Neither file changed
    expect(fs.readFileSync(J(r, 'a.ts'), 'utf8')).toBe('original');
    expect(fs.readFileSync(J(r, 'b.ts'), 'utf8')).toBe('existing');
  });

  it('refuses when no workspace roots are provided', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const res = await fsMove(J(r, 'a.ts'), J(r, 'b.ts'), []);
    expect(res.ok).toBe(false);
  });

  it('refuses a ../ escape attempt', async () => {
    const r = root();
    const other = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    // Try to move to ../other (escape the root via ..)
    const res = await fsMove(J(r, 'a.ts'), J(r, '..', path.basename(other), 'escaped.ts'), [r]);
    expect(res.ok).toBe(false);
  });
});

describe('fsCopy — guarded copy against a real temp dir', () => {
  it('copies a file and keeps the source', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'hello');
    const res = await fsCopy(J(r, 'a.ts'), J(r, 'sub', 'a.ts'), [r]);
    expect(res.ok).toBe(true);
    // Source still exists
    expect(fs.readFileSync(J(r, 'a.ts'), 'utf8')).toBe('hello');
    // Destination created
    expect(fs.readFileSync(J(r, 'sub', 'a.ts'), 'utf8')).toBe('hello');
  });

  it('copies a folder recursively and keeps the source', async () => {
    const r = root();
    fs.mkdirSync(J(r, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(J(r, 'src', 'index.ts'), 'src');
    fs.writeFileSync(J(r, 'src', 'utils', 'helper.ts'), 'helper');
    const res = await fsCopy(J(r, 'src'), J(r, 'backup'), [r]);
    expect(res.ok).toBe(true);
    // Source intact
    expect(fs.existsSync(J(r, 'src', 'utils', 'helper.ts'))).toBe(true);
    // Destination has full tree
    expect(fs.readFileSync(J(r, 'backup', 'index.ts'), 'utf8')).toBe('src');
    expect(fs.readFileSync(J(r, 'backup', 'utils', 'helper.ts'), 'utf8')).toBe('helper');
  });

  it('refuses when source is outside the workspace root', async () => {
    const r = root();
    const outside = root();
    fs.writeFileSync(J(outside, 'evil.ts'), 'x');
    const res = await fsCopy(J(outside, 'evil.ts'), J(r, 'evil.ts'), [r]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/outside the workspace/i);
  });

  it('refuses when destination is outside the workspace root', async () => {
    const r = root();
    const outside = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const res = await fsCopy(J(r, 'a.ts'), J(outside, 'escaped.ts'), [r]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/outside the workspace/i);
    expect(fs.existsSync(J(outside, 'escaped.ts'))).toBe(false);
  });

  it('refuses when destination already exists (no silent overwrite)', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'new');
    fs.writeFileSync(J(r, 'b.ts'), 'keep');
    const res = await fsCopy(J(r, 'a.ts'), J(r, 'b.ts'), [r]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already exists/i);
    expect(fs.readFileSync(J(r, 'b.ts'), 'utf8')).toBe('keep');
  });

  it('refuses when no workspace roots are provided', async () => {
    const r = root();
    fs.writeFileSync(J(r, 'a.ts'), 'x');
    const res = await fsCopy(J(r, 'a.ts'), J(r, 'b.ts'), []);
    expect(res.ok).toBe(false);
  });
});
