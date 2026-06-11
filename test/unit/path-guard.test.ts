import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isInsideAnyRoot, isInsideRoot, realPathLeaf, validateWrite } from '../../src/path-guard';

function tmp(prefix = 'guard-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const created: string[] = [];
function root(prefix = 'guard-'): string {
  const d = tmp(prefix);
  created.push(d);
  return d;
}
afterEach(() => {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('isInsideRoot — containment primitive', () => {
  it('accepts a file directly inside the root', () => {
    expect(isInsideRoot('/work/a.ts', '/work')).toBe(true);
  });
  it('accepts a deeply nested file', () => {
    expect(isInsideRoot('/work/src/x/y/z.ts', '/work')).toBe(true);
  });
  it('rejects a path that escapes via ..', () => {
    expect(isInsideRoot('/work/../etc/passwd', '/work')).toBe(false);
  });
  it('rejects a sibling root with a shared prefix (no separator boundary)', () => {
    // The classic prefix bug: "/work-evil" must NOT match root "/work".
    expect(isInsideRoot('/work-evil/secret', '/work')).toBe(false);
  });
  it('rejects an absolute path entirely outside the root', () => {
    expect(isInsideRoot('/etc/hosts', '/work')).toBe(false);
  });
});

describe('isInsideAnyRoot — multi-root containment', () => {
  it('accepts when inside ANY one of several roots', () => {
    expect(isInsideAnyRoot('/b/file.ts', ['/a', '/b', '/c'])).toBe(true);
  });
  it('rejects when inside none of the roots', () => {
    expect(isInsideAnyRoot('/d/file.ts', ['/a', '/b', '/c'])).toBe(false);
  });
});

describe('validateWrite — the trust boundary', () => {
  it('ACCEPTS a normal file inside the workspace root', () => {
    const r = root();
    const target = path.join(r, 'src', 'index.ts');
    const res = validateWrite(target, [r]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe(path.resolve(target));
  });

  it('REJECTS a ".." escape out of the root', () => {
    const r = root();
    const target = path.join(r, '..', 'outside.ts');
    const res = validateWrite(target, [r]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/outside the workspace/i);
  });

  it('REJECTS an absolute path outside every root', () => {
    const r = root();
    const outside = path.join(os.tmpdir(), 'definitely-outside.ts');
    const res = validateWrite(outside, [r]);
    expect(res.ok).toBe(false);
  });

  it('REJECTS a path in a sibling root not in the allow-list', () => {
    const a = root('guard-a-');
    const b = root('guard-b-');
    // b is a real, existing directory — just not one of the permitted roots.
    const res = validateWrite(path.join(b, 'x.ts'), [a]);
    expect(res.ok).toBe(false);
  });

  it('REJECTS when there are no open roots at all', () => {
    const res = validateWrite('/anything.ts', []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no open workspace/i);
  });

  it('REJECTS writing over a directory', () => {
    const r = root();
    const sub = path.join(r, 'adir');
    fs.mkdirSync(sub);
    const res = validateWrite(sub, [r]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/directory/i);
  });

  it('REJECTS a symlink whose real path escapes the root (symlink traversal)', () => {
    const r = root('guard-root-');
    const outsideDir = root('guard-out-');
    const outsideFile = path.join(outsideDir, 'secret.ts');
    fs.writeFileSync(outsideFile, 'secret');
    const link = path.join(r, 'link.ts');
    try {
      fs.symlinkSync(outsideFile, link);
    } catch {
      // Symlink creation can fail without privilege on Windows — skip gracefully.
      return;
    }
    // Lexically the link is inside r, but its REAL path is outside — must reject.
    expect(isInsideRoot(link, r)).toBe(true); // lexical check passes...
    const res = validateWrite(link, [r]);
    expect(res.ok).toBe(false); // ...real-path check catches it.
    if (!res.ok) expect(res.error).toMatch(/symlink/i);
  });

  it('REJECTS a file under a symlinked PARENT dir that points outside the root', () => {
    const r = root('guard-root2-');
    const outsideDir = root('guard-out2-');
    const linkedDir = path.join(r, 'linkdir');
    try {
      fs.symlinkSync(outsideDir, linkedDir, 'dir');
    } catch {
      return; // no symlink privilege — skip
    }
    const target = path.join(linkedDir, 'new.ts'); // not yet existing
    const res = validateWrite(target, [r]);
    expect(res.ok).toBe(false);
  });
});

describe('realPathLeaf — resolves through symlinks even for missing files', () => {
  it('resolves a not-yet-existing file under a symlinked parent to the real target', () => {
    const r = root('guard-rp-');
    const realDir = root('guard-rp2-');
    const linkedDir = path.join(r, 'link');
    try {
      fs.symlinkSync(realDir, linkedDir, 'dir');
    } catch {
      return;
    }
    const resolved = realPathLeaf(path.join(linkedDir, 'created-later.ts'));
    expect(resolved).toBe(path.join(realDir, 'created-later.ts'));
  });
});
