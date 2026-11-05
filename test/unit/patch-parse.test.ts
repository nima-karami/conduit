import { describe, expect, it } from 'vitest';
import {
  type ParsedPatchFile,
  parsePatch,
  patchFilesToFileDiffs,
  patchOverSizeCap,
} from '../../src/patch-parse';

function okFiles(text: string): ParsedPatchFile[] {
  const r = parsePatch(text);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.reason);
  return r.files;
}

function failReason(text: string): string {
  const r = parsePatch(text);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.reason;
}

describe('parsePatch', () => {
  it('parses a git diff with several files', () => {
    const patch = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+three
 four
@@ -10,2 +10,2 @@
 ten
-eleven
+twelve
@@ -20,2 +20,3 @@
 twenty
+twenty-one
 twenty-two
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,3 @@
 alpha
+beta
 gamma
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('src/a.ts');
    expect(files[0].head).toBe('one\ntwo\nfour\nten\neleven\ntwenty\ntwenty-two\n');
    expect(files[0].work).toBe('one\nthree\nfour\nten\ntwelve\ntwenty\ntwenty-one\ntwenty-two\n');
    expect(files[0].counts).toEqual({ added: 3, removed: 2 });
    expect(files[1].path).toBe('src/b.ts');
    expect(files[1].counts).toEqual({ added: 1, removed: 0 });
  });

  it('parses a rename with changes', () => {
    const patch = `diff --git a/old.txt b/new.txt
similarity index 85%
rename from old.txt
rename to new.txt
index 111..222 100644
--- a/old.txt
+++ b/new.txt
@@ -1,3 +1,3 @@
 first
-second
+changed
 third
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new.txt');
    expect(files[0].oldPath).toBe('old.txt');
    expect(files[0].changeKind).toBe('R');
    expect(files[0].counts).toEqual({ added: 1, removed: 1 });
  });

  it('parses a new file and a deleted file', () => {
    const patch = `diff --git a/added.txt b/added.txt
new file mode 100644
index 000..111
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/removed.txt b/removed.txt
deleted file mode 100644
index 222..000
--- a/removed.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-goodbye
-world
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('added.txt');
    expect(files[0].changeKind).toBe('A');
    expect(files[0].head).toBe('');
    expect(files[0].work).toBe('hello\nworld\n');
    expect(files[1].path).toBe('removed.txt');
    expect(files[1].changeKind).toBe('D');
    expect(files[1].head).toBe('goodbye\nworld\n');
    expect(files[1].work).toBe('');
  });

  it('parses a mode change', () => {
    const patch = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('script.sh');
    expect(files[0].changeKind).toBe('T');
    expect(files[0].mode).toEqual({ old: '100644', new: '100755' });
    expect(files[0].head).toBe('');
    expect(files[0].work).toBe('');
  });

  it('parses a binary file', () => {
    const patch = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('image.png');
    expect(files[0].binary).toBe(true);
    expect(files[0].changeKind).toBe('M');
    expect(files[0].head).toBe('');
    expect(files[0].work).toBe('');
  });

  it('parses a bare diff -u output with no git header', () => {
    const patch = `--- old/file.txt	2026-01-01 00:00:00
+++ new/file.txt	2026-01-02 00:00:00
@@ -1,3 +1,3 @@
 a
-b
+c
 d
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new/file.txt');
    expect(files[0].head).toBe('a\nb\nd\n');
    expect(files[0].work).toBe('a\nc\nd\n');
  });

  it('handles \\ No newline at end of file', () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 one
-two
+two-plus
\\ No newline at end of file
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].head).toBe('one\ntwo\n');
    expect(files[0].work).toBe('one\ntwo-plus');
  });

  it('handles CRLF patches', () => {
    const patch = `diff --git a/file.txt b/file.txt\r\nindex 111..222 100644\r\n--- a/file.txt\r\n+++ b/file.txt\r\n@@ -1,2 +1,2 @@\r\n one\r\n-two\r\n+three\r\n`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].head).toBe('one\ntwo\n');
    expect(files[0].work).toBe('one\nthree\n');
  });

  it('rejects a hunk-count mismatch', () => {
    const reason = failReason(`--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 one
+two
`);
    expect(reason).toContain('hunk line count mismatch');
  });

  it('rejects non-diff text', () => {
    expect(failReason('hello world')).toBe('not a unified diff');
    expect(failReason('')).toBe('empty patch');
  });

  it('rejects an unknown line inside a hunk', () => {
    const reason = failReason(`--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 one
?bad
`);
    expect(reason).toContain('unexpected line in hunk');
  });

  it('converts parsed files to FileDiffDTOs and keeps real hunk starts', () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,3 @@
 one
-two
+two-a
+two-b
`;
    const files = okFiles(patch);
    const dtos = patchFilesToFileDiffs(files);
    expect(dtos).toHaveLength(1);
    expect(dtos[0]).toMatchObject({
      path: 'file.txt',
      head: 'one\ntwo\n',
      work: 'one\ntwo-a\ntwo-b\n',
      binary: false,
      counts: { added: 2, removed: 1 },
    });
    expect(dtos[0].hunks).toHaveLength(1);
    expect(dtos[0].hunks?.[0]).toMatchObject({ startOldLine: 1, startNewLine: 1 });
  });

  it('carries two distant hunks at their original line numbers', () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -10,2 +10,2 @@
 ten
-eleven
+changed-eleven
@@ -200,2 +200,2 @@
 two-hundred
-old
+new
`;
    const files = okFiles(patch);
    const dtos = patchFilesToFileDiffs(files);
    expect(dtos[0].hunks?.map((h) => ({ old: h.startOldLine, neu: h.startNewLine }))).toEqual([
      { old: 10, neu: 10 },
      { old: 200, neu: 200 },
    ]);
    expect(dtos[0].hunks?.[0].lines.map((l) => l.text)).toEqual([
      'ten',
      'eleven',
      'changed-eleven',
    ]);
    expect(dtos[0].hunks?.[1].lines.map((l) => l.text)).toEqual(['two-hundred', 'old', 'new']);
  });

  it('enforces the 5 MB size cap helper', () => {
    const big = 'a'.repeat(5 * 1024 * 1024 + 1);
    expect(patchOverSizeCap(big)).toBe(true);
    expect(patchOverSizeCap('small')).toBe(false);
  });

  it('skips git format-patch mail headers and the signature trailer', () => {
    const patch = `From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001
From: Dev <dev@example.com>
Date: Thu, 5 Nov 2026 12:00:00 -0500
Subject: [PATCH] tweak

---
 src/a.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+three
 four
-- 
2.47.0
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
    expect(files[0].head).toBe('one\ntwo\nfour\n');
    expect(files[0].work).toBe('one\nthree\nfour\n');
  });

  it('parses an svn diff with Index and equals-separator noise', () => {
    const patch = `Index: file.txt
===================================================================
--- file.txt	(revision 12)
+++ file.txt	(working copy)
@@ -1,2 +1,2 @@
 hello
-world
+there
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('file.txt');
    expect(files[0].head).toBe('hello\nworld\n');
    expect(files[0].work).toBe('hello\nthere\n');
  });

  it('parses an hg diff with a diff -r header', () => {
    const patch = `diff -r 1a2b3c4d5e6f a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 hello
-world
+there
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('a.txt');
    expect(files[0].work).toBe('hello\nthere\n');
  });

  it('keeps a deleted SQL -- comment inside the hunk', () => {
    const patch = `diff --git a/query.sql b/query.sql
index 111..222 100644
--- a/query.sql
+++ b/query.sql
@@ -1,3 +1,3 @@
 SELECT 1;
--- comment
+-- other
 FROM t;
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0].head).toBe('SELECT 1;\n-- comment\nFROM t;\n');
    expect(files[0].work).toBe('SELECT 1;\n-- other\nFROM t;\n');
    expect(files[0].hunks[0].lines.map((l) => l.kind)).toEqual([
      'context',
      'del',
      'add',
      'context',
    ]);
  });

  it('treats a blank hunk-body line as context', () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,4 @@
 a

-b
+c
 d
`;
    const files = okFiles(patch);
    expect(files[0].head).toBe('a\n\nb\nd\n');
    expect(files[0].work).toBe('a\n\nc\nd\n');
    expect(files[0].hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['context', ''],
      ['del', 'b'],
      ['add', 'c'],
      ['context', 'd'],
    ]);
  });

  it('parses an empty new file from a git header with no hunks', () => {
    const patch = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'empty.txt',
      changeKind: 'A',
      head: '',
      work: '',
      hunks: [],
      counts: { added: 0, removed: 0 },
    });
  });

  it('parses an empty deleted file from a git header with no hunks', () => {
    const patch = `diff --git a/empty.txt b/empty.txt
deleted file mode 100644
index e69de29..0000000
`;
    const files = okFiles(patch);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'empty.txt',
      changeKind: 'D',
      head: '',
      work: '',
      hunks: [],
    });
  });

  it('parses a 100% rename with no hunks', () => {
    const patch = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;
    const files = okFiles(patch);
    expect(files[0]).toMatchObject({ path: 'new.txt', oldPath: 'old.txt', changeKind: 'R' });
  });

  it('rejects a git header with no hunks and no rename, mode, or binary change', () => {
    expect(
      failReason(`diff --git a/foo.txt b/foo.txt
index 111..222 100644
`),
    ).toContain('no hunks');
  });

  it('keeps a context line that looks like a diff header inside the hunk', () => {
    const patch = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 diff --git a/x b/x
-old
+new
`;
    const files = okFiles(patch);
    expect(files[0].head).toBe('diff --git a/x b/x\nold\n');
    expect(files[0].work).toBe('diff --git a/x b/x\nnew\n');
  });

  it('rejects absolute, drive-letter, and .. header paths', () => {
    expect(
      failReason(`--- /etc/passwd
+++ /etc/passwd
@@ -1 +1 @@
-a
+b
`),
    ).toBe('invalid path in diff header');
    expect(
      failReason(`--- a/C:/Windows/win.ini
+++ b/C:/Windows/win.ini
@@ -1 +1 @@
-a
+b
`),
    ).toBe('invalid path in diff header');
    expect(
      failReason(`diff --git a/../../secret b/../../secret
index 111..222 100644
--- a/../../secret
+++ b/../../secret
@@ -1 +1 @@
-a
+b
`),
    ).toBe('invalid path in diff header');
    expect(
      failReason(`--- a/foo/../../x
+++ b/foo/../../x
@@ -1 +1 @@
-a
+b
`),
    ).toBe('invalid path in diff header');
  });

  it('does not echo patch content in parse errors', () => {
    const reason = failReason(`--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 one
?secret-token-xyz
`);
    expect(reason).toContain('unexpected line in hunk');
    expect(reason).not.toContain('secret-token-xyz');
    expect(reason.toLowerCase()).not.toContain('got:');
  });
});
