import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropIntent } from '../../src/drop-intent';

// Helpers to build OS-native paths
const J = (...p: string[]) => path.join(...p);
const ROOT = process.platform === 'win32' ? 'C:\\project' : '/project';
// dropIntent is browser-safe (no node:path): it normalizes dest to forward slashes,
// which the host fs + path-guard accept on Windows. Inputs stay OS-native (J); the
// returned dest is asserted in forward-slash form (D).
const D = (...p: string[]) =>
  [process.platform === 'win32' ? 'C:/project' : '/project', ...p].join('/');

describe('dropIntent — modifier mapping', () => {
  it('default (no modifiers) → move', () => {
    const result = dropIntent({
      source: J(ROOT, 'src', 'foo.ts'),
      targetDir: J(ROOT, 'lib'),
      modifiers: {},
    });
    expect(result).not.toBeNull();
    expect(result?.op).toBe('move');
  });

  it('Ctrl → copy', () => {
    const result = dropIntent({
      source: J(ROOT, 'src', 'foo.ts'),
      targetDir: J(ROOT, 'lib'),
      modifiers: { ctrl: true },
    });
    expect(result).not.toBeNull();
    expect(result?.op).toBe('copy');
  });

  it('Shift → move (not link)', () => {
    const result = dropIntent({
      source: J(ROOT, 'src', 'foo.ts'),
      targetDir: J(ROOT, 'lib'),
      modifiers: { shift: true },
    });
    expect(result?.op).toBe('move');
  });

  it('Alt → move (not link)', () => {
    const result = dropIntent({
      source: J(ROOT, 'src', 'foo.ts'),
      targetDir: J(ROOT, 'lib'),
      modifiers: { alt: true },
    });
    expect(result?.op).toBe('move');
  });

  it('Ctrl+Shift → copy (Ctrl wins)', () => {
    const result = dropIntent({
      source: J(ROOT, 'src', 'foo.ts'),
      targetDir: J(ROOT, 'lib'),
      modifiers: { ctrl: true, shift: true },
    });
    expect(result?.op).toBe('copy');
  });
});

describe('dropIntent — dest composition', () => {
  it('dest = targetDir + basename(source)', () => {
    const result = dropIntent({
      source: J(ROOT, 'src', 'utils.ts'),
      targetDir: J(ROOT, 'lib'),
      modifiers: {},
    });
    expect(result).not.toBeNull();
    expect(result?.dest).toBe(D('lib', 'utils.ts'));
  });

  it('basename stripped from trailing sep on source dir', () => {
    const src =
      process.platform === 'win32' ? 'C:\\project\\src\\components\\' : '/project/src/components/';
    const result = dropIntent({
      source: src,
      targetDir: J(ROOT, 'lib'),
      modifiers: {},
    });
    // basename of path with trailing sep is "components"
    expect(result?.dest).toBe(D('lib', 'components'));
  });

  it('works with deeply nested source paths', () => {
    const result = dropIntent({
      source: J(ROOT, 'a', 'b', 'c', 'file.ts'),
      targetDir: J(ROOT, 'x'),
      modifiers: {},
    });
    expect(result?.dest).toBe(D('x', 'file.ts'));
  });
});

describe('dropIntent — null (no-op) cases', () => {
  it('returns null when source === targetDir (self-drop)', () => {
    const dir = J(ROOT, 'src');
    expect(dropIntent({ source: dir, targetDir: dir, modifiers: {} })).toBeNull();
  });

  it('returns null when dropping a folder into itself', () => {
    const dir = J(ROOT, 'src');
    // source is the folder being dragged; targetDir is that same folder
    expect(dropIntent({ source: dir, targetDir: dir, modifiers: {} })).toBeNull();
  });

  it('returns null when dropping a folder into a descendant', () => {
    const parent = J(ROOT, 'src');
    const descendant = J(ROOT, 'src', 'components', 'nested');
    expect(dropIntent({ source: parent, targetDir: descendant, modifiers: {} })).toBeNull();
  });

  it('returns null when dropping a folder into its direct child', () => {
    const parent = J(ROOT, 'src');
    const child = J(ROOT, 'src', 'components');
    expect(dropIntent({ source: parent, targetDir: child, modifiers: {} })).toBeNull();
  });

  it('returns null when dest === source (same directory — no-op move)', () => {
    // foo.ts is in /project/src; dropping it onto /project/src would resolve
    // to /project/src/foo.ts which is the same as source
    const source = J(ROOT, 'src', 'foo.ts');
    const targetDir = J(ROOT, 'src');
    expect(dropIntent({ source, targetDir, modifiers: {} })).toBeNull();
  });

  it('does NOT return null when dropping a child into a sibling folder', () => {
    const source = J(ROOT, 'src', 'foo.ts');
    const targetDir = J(ROOT, 'lib');
    const result = dropIntent({ source, targetDir, modifiers: {} });
    expect(result).not.toBeNull();
  });
});

describe('dropIntent — Windows path normalization', () => {
  it('normalizes backslash paths', () => {
    // Simulate Windows-style paths regardless of platform
    const source = 'C:/project/src/foo.ts'.replace(/\//g, path.sep);
    const targetDir = 'C:/project/lib'.replace(/\//g, path.sep);
    const result = dropIntent({ source, targetDir, modifiers: {} });
    // Should produce a result (not null) and dest should include lib/foo.ts
    if (result) {
      expect(result.dest).toContain('foo.ts');
      expect(result.op).toBe('move');
    }
    // On windows specifically, verify backslash paths are handled
    if (process.platform === 'win32') {
      expect(result).not.toBeNull();
    }
  });

  it('same-dir detection works with mixed slash styles', () => {
    // When source is in /project/src and targetDir is /project/src (same)
    const source = J(ROOT, 'src', 'foo.ts');
    // same directory as source
    const targetDir = path.dirname(source);
    expect(dropIntent({ source, targetDir, modifiers: {} })).toBeNull();
  });
});

describe('dropIntent — folders can be dropped', () => {
  it('a folder can be moved into a sibling folder', () => {
    const src = J(ROOT, 'src', 'components');
    const target = J(ROOT, 'lib');
    const result = dropIntent({ source: src, targetDir: target, modifiers: {} });
    expect(result).not.toBeNull();
    expect(result?.op).toBe('move');
    expect(result?.dest).toBe(D('lib', 'components'));
  });

  it('a folder cannot be moved into its own subtree', () => {
    const src = J(ROOT, 'src');
    const target = J(ROOT, 'src', 'sub', 'deep');
    expect(dropIntent({ source: src, targetDir: target, modifiers: {} })).toBeNull();
  });
});
