/**
 * Folding for Markdown SOURCE (spec 2026-10-08-language-support §2.7). Monaco's markdown folds only
 * on indentation and `#region` markers, and a registered provider REPLACES both, so this emits
 * region markers and fenced blocks itself alongside heading sections. Monaco-free so it runs in
 * the node test env; registered in monaco-languages.ts.
 */

/** 1-based inclusive lines, the shape `FoldingRangeProvider` takes. */
export interface FoldRange {
  start: number;
  end: number;
  kind?: 'region';
}

const HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const REGION_START = /^\s*<!--\s*#region\b.*-->/;
const REGION_END = /^\s*<!--\s*#endregion\b.*-->/;

export function markdownFoldingRanges(lines: readonly string[]): FoldRange[] {
  const out: FoldRange[] = [];
  const headings: { level: number; start: number }[] = [];
  const regions: number[] = [];
  let fence: { mark: string; start: number } | null = null;
  // A section ends on its last non-blank line, not on the blank lines before the next heading.
  let lastNonBlank = 0;

  const closeHeadings = (minLevel: number) => {
    while (headings.length > 0 && headings[headings.length - 1].level >= minLevel) {
      const h = headings.pop();
      if (h && lastNonBlank > h.start) out.push({ start: h.start, end: lastNonBlank });
    }
  };

  lines.forEach((text, i) => {
    const line = i + 1;
    if (fence) {
      const close = FENCE.exec(text);
      const mark = close?.[1];
      if (
        mark &&
        mark[0] === fence.mark[0] &&
        mark.length >= fence.mark.length &&
        text.slice(text.indexOf(mark) + mark.length).trim() === ''
      ) {
        out.push({ start: fence.start, end: line });
        fence = null;
      }
    } else {
      const open = FENCE.exec(text);
      const heading = HEADING.exec(text);
      if (open) fence = { mark: open[1], start: line };
      else if (heading) {
        closeHeadings(heading[1].length);
        headings.push({ level: heading[1].length, start: line });
      } else if (REGION_START.test(text)) regions.push(line);
      else if (REGION_END.test(text)) {
        const start = regions.pop();
        if (start !== undefined) out.push({ start, end: line, kind: 'region' });
      }
    }
    if (text.trim() !== '') lastNonBlank = line;
  });
  closeHeadings(1);
  return out.sort((a, b) => a.start - b.start);
}
