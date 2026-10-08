/**
 * Folding for patch files (spec 2026-10-08-language-coverage §2.3): one range per `diff --git`
 * file and one per `@@` hunk. Monaco-free so it runs in the node test env; registered in
 * monaco-languages.ts.
 */

/** 1-based inclusive lines, the shape `FoldingRangeProvider` takes. */
export function diffFoldingRanges(lines: readonly string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let file: number | null = null;
  let hunk: number | null = null;
  const close = (start: number | null, end: number) => {
    if (start !== null && end > start) out.push({ start, end });
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.startsWith('diff --git ')) {
      close(hunk, n - 1);
      close(file, n - 1);
      hunk = null;
      file = n;
    } else if (line.startsWith('@@')) {
      close(hunk, n - 1);
      hunk = n;
    }
  });
  close(hunk, lines.length);
  close(file, lines.length);
  return out;
}
