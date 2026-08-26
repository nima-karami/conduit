/**
 * One path identity — spec docs/specs/2026-08-21-goto-definition-flows.md contract 4.
 *
 * Two invariants are load-bearing and neither is obvious from reading either side alone:
 *   1. the tab store keys by the path STRING, so the tree's spelling and the one the
 *      go-to-definition opener derives from a Monaco URI have to collapse to one; and
 *   2. the extraLib key and the model URI are the SAME string, because monaco looks a
 *      navigation target up in `getExtraLibs()` by exact string.
 *
 * `monaco-editor`'s barrel wants a DOM, so the real (DOM-free) `Uri` is substituted for it —
 * mocking `Uri` itself would test the mock's idea of escaping rather than Monaco's.
 */

import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
import { describe, expect, it, vi } from 'vitest';
import { canonicalPath, fileUri, pathForUri } from '../../webview/project-index';
import { buildFileNameAliases, rawForm } from '../../webview/ts-worker-names';

vi.mock('monaco-editor', async () => ({
  Uri: (await import('monaco-editor/esm/vs/base/common/uri.js')).URI,
}));

describe('canonicalPath', () => {
  it('uppercases the drive letter', () => {
    expect(canonicalPath('c:\\repo\\src\\a.ts')).toBe('C:\\repo\\src\\a.ts');
  });

  it('rewrites forward slashes on a Windows path', () => {
    expect(canonicalPath('C:/repo/src/a.ts')).toBe('C:\\repo\\src\\a.ts');
  });

  it('drops the leading slash a Monaco URI path carries', () => {
    expect(canonicalPath('/c:/repo/src/a.ts')).toBe('C:\\repo\\src\\a.ts');
  });

  it('is idempotent', () => {
    const once = canonicalPath('/c:/repo/src/a.ts');
    expect(canonicalPath(once)).toBe(once);
  });

  it('leaves special characters in place', () => {
    expect(canonicalPath('c:/repo/c#/mod.ts')).toBe('C:\\repo\\c#\\mod.ts');
    expect(canonicalPath('c:/repo/with space/mod.ts')).toBe('C:\\repo\\with space\\mod.ts');
    expect(canonicalPath('c:/repo/q?dir/mod.ts')).toBe('C:\\repo\\q?dir\\mod.ts');
    expect(canonicalPath('c:/repo/pct%20dir/mod.ts')).toBe('C:\\repo\\pct%20dir\\mod.ts');
  });

  it('leaves POSIX paths alone', () => {
    expect(canonicalPath('/home/nima/repo/src/a.ts')).toBe('/home/nima/repo/src/a.ts');
  });

  it('leaves UNC and extended-length paths alone', () => {
    expect(canonicalPath('\\\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts');
    expect(canonicalPath('\\\\?\\c:\\repo\\a.ts')).toBe('\\\\?\\c:\\repo\\a.ts');
  });

  it('leaves a drive-relative path alone (no separator, so no path to rewrite)', () => {
    expect(canonicalPath('C:a.ts')).toBe('C:a.ts');
  });
});

describe('fileUri', () => {
  it('gives the tree spelling and the opener spelling the same URI', () => {
    const fromTree = fileUri('C:\\repo\\src\\first\\rel-target.ts');
    const fromOpener = fileUri('/c:/repo/src/first/rel-target.ts');
    expect(fromOpener.toString()).toBe(fromTree.toString());
  });

  it('escapes # instead of taking it as a fragment', () => {
    const uri = fileUri('C:\\repo\\c#\\mod.ts');
    expect(uri.toString()).toContain('c%23/mod.ts');
    expect(uri.fragment).toBe('');
  });

  it('escapes ? instead of taking it as a query', () => {
    const uri = fileUri('C:\\repo\\q?dir\\mod.ts');
    expect(uri.toString()).toContain('q%3Fdir/mod.ts');
    expect(uri.query).toBe('');
  });

  it('escapes a space and a literal percent distinctly', () => {
    expect(fileUri('C:\\repo\\with space\\mod.ts').toString()).toContain('with%20space/mod.ts');
    expect(fileUri('C:\\repo\\pct%20dir\\mod.ts').toString()).toContain('pct%2520dir/mod.ts');
  });

  it('survives the round trip monaco makes when it materialises the target model', () => {
    // `LibFiles.getOrCreateModel` re-parses the extraLib KEY into the model's URI, and that
    // model's `toString()` is what the opener and the next `fileUri` call compare against.
    for (const p of ['C:\\repo\\c#\\mod.ts', 'C:\\repo\\with space\\m.ts', 'C:\\repo\\a.ts']) {
      const key = fileUri(p).toString();
      expect(URI.parse(key).toString()).toBe(key);
    }
  });
});

describe('pathForUri', () => {
  it('round-trips a registered path exactly', () => {
    for (const p of [
      'C:\\repo\\src\\a.ts',
      'C:\\repo\\c#\\mod.ts',
      'C:\\repo\\with space\\mod.ts',
      'C:\\repo\\q?dir\\mod.ts',
      'C:\\repo\\pct%20dir\\mod.ts',
    ]) {
      expect(pathForUri(fileUri(p))).toBe(p);
    }
  });

  it('canonicalises the drive case for a URI it never issued', () => {
    expect(pathForUri(URI.parse('file:///c%3A/repo/src/never-indexed.ts'))).toBe(
      'C:\\repo\\src\\never-indexed.ts',
    );
  });
});

describe('rawForm', () => {
  it('leaves a key with nothing to escape untouched', () => {
    const key = 'file:///c%3A/repo/src/a.ts';
    expect(rawForm(key)).toBe(key);
  });

  it('reproduces the string join TypeScript performs', () => {
    // `…/src/first/uses-space.ts` + `../../with space/mod` — escaped prefix, raw segment.
    expect(rawForm('file:///c%3A/repo/with%20space/mod.ts')).toBe(
      'file:///c%3A/repo/with space/mod.ts',
    );
    expect(rawForm('file:///c%3A/repo/c%23/mod.ts')).toBe('file:///c%3A/repo/c#/mod.ts');
    expect(rawForm('file:///c%3A/repo/q%3Fdir/mod.ts')).toBe('file:///c%3A/repo/q?dir/mod.ts');
    expect(rawForm('file:///c%3A/repo/pct%2520dir/mod.ts')).toBe(
      'file:///c%3A/repo/pct%20dir/mod.ts',
    );
  });

  it('keeps a POSIX key without a drive marker', () => {
    expect(rawForm('file:///home/nima/with%20space/mod.ts')).toBe(
      'file:///home/nima/with space/mod.ts',
    );
  });

  it('falls back to the key when the escaping is malformed', () => {
    expect(rawForm('file:///c%3A/repo/100%/mod.ts')).toBe('file:///c%3A/repo/100%/mod.ts');
  });
});

describe('buildFileNameAliases', () => {
  it('is empty for a project with nothing to escape', () => {
    expect(buildFileNameAliases(['file:///c%3A/repo/a.ts', 'file:///c%3A/repo/b/c.ts']).size).toBe(
      0,
    );
  });

  it('maps the raw spelling back to the key', () => {
    const aliases = buildFileNameAliases([
      'file:///c%3A/repo/with%20space/mod.ts',
      'file:///c%3A/repo/c%23/mod.ts',
    ]);
    expect(aliases.get('file:///c%3A/repo/with space/mod.ts')).toBe(
      'file:///c%3A/repo/with%20space/mod.ts',
    );
    expect(aliases.get('file:///c%3A/repo/c#/mod.ts')).toBe('file:///c%3A/repo/c%23/mod.ts');
  });

  it('never lets an alias shadow a file that really has that name', () => {
    // `pct%20dir` (a literal percent) escapes to `pct%2520dir`, whose raw form collides with
    // the key of `pct dir`. The real file must keep its own key.
    const real = 'file:///c%3A/repo/pct%20dir/mod.ts';
    const aliases = buildFileNameAliases([real, 'file:///c%3A/repo/pct%2520dir/mod.ts']);
    expect(aliases.has(real)).toBe(false);
  });
});
