import type { BlameLine } from './protocol';

/**
 * PURE, node-free parser for `git blame --porcelain` (host spawn lives in git-history.ts as
 * `getBlame`). Unit-tested in test/unit/git-blame.test.ts.
 *
 * Porcelain shape: each blamed line starts with a header `<40-hex-sha> <origLine> <finalLine>
 * [count]` (the trailing count appears only on the first line of a run). A sha's commit metadata
 * (`author`, `author-time`, `summary`, `previous`, `filename`, …) is emitted only on that sha's
 * FIRST appearance; later lines carry just the header + a TAB-prefixed content line. So we cache
 * header fields by sha and attach them to every line, including a sha's re-appearance further down.
 *
 * An uncommitted line comes back as the all-zero sha with author "Not Committed Yet" — flagged
 * `uncommitted` so the UI never links it to a commit.
 */

const ZERO_SHA = '0'.repeat(40);
const HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

interface HeaderFields {
  author: string;
  authorTime: number;
  summary: string;
}

export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  const cache = new Map<string, HeaderFields>();
  let sha = '';
  let finalLine = 0;
  // Fields accumulated during the current sha's first-appearance metadata block.
  let pending: Partial<HeaderFields> = {};

  for (const row of stdout.split('\n')) {
    const header = HEADER_RE.exec(row);
    if (header) {
      sha = header[1];
      finalLine = Number.parseInt(header[2], 10);
      pending = {};
      continue;
    }
    if (!sha) continue;

    if (row.startsWith('\t')) {
      let fields = cache.get(sha);
      if (!fields) {
        fields = {
          author: pending.author ?? '',
          authorTime: pending.authorTime ?? 0,
          summary: pending.summary ?? '',
        };
        cache.set(sha, fields);
      }
      const line: BlameLine = {
        line: finalLine,
        sha,
        author: fields.author,
        authorTime: fields.authorTime,
        summary: fields.summary,
      };
      if (sha === ZERO_SHA || fields.author === 'Not Committed Yet') line.uncommitted = true;
      out.push(line);
      continue;
    }

    const sp = row.indexOf(' ');
    const key = sp === -1 ? row : row.slice(0, sp);
    const value = sp === -1 ? '' : row.slice(sp + 1);
    if (key === 'author') pending.author = value;
    else if (key === 'author-time') pending.authorTime = Number.parseInt(value, 10);
    else if (key === 'summary') pending.summary = value;
  }
  return out;
}
