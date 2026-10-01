import type { PlanBlock } from './plan-blocks';

/**
 * `replaces` names the one old block a new one stands in for — the caller sets it when the keeps on
 * either side leave exactly one old block between them — so a rewritten fence keeps its own opener,
 * closer and surrounding bytes (spec §3.2, plan Task 1.3.3).
 */
export type SpliceItem =
  | { kind: 'keep'; oldIndex: number }
  | { kind: 'new'; source: string; replaces?: number };

type Eol = '\n' | '\r\n';

const FENCE_RE = /^(`{3,}|~{3,})/;

function dominantEol(body: string): Eol {
  const crlf = body.match(/\r\n/g)?.length ?? 0;
  const lf = (body.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

const isCloser = (line: string, fence: string): boolean =>
  new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line);

/**
 * The serialiser re-spells a fence it re-emits (``` for ~~~, the info string cut to the language),
 * so a fence→fence replacement keeps the old opener and closer and takes only the new content.
 * `null` when that would not be the same fence: an indented opener (its content is indented too), a
 * changed language (the old opener would restate the old one), or content holding a line that
 * would close the old fence early.
 */
function rewrapFence(old: string, next: string, eol: Eol): string | null {
  const oldLines = old.split(/\r?\n/);
  const nextLines = next.split(/\r?\n/);
  const opener = FENCE_RE.exec(oldLines[0]);
  const nextOpener = FENCE_RE.exec(nextLines[0]);
  if (!opener || !nextOpener) return null;
  const language = (line: string, fence: string) => line.slice(fence.length).trim().split(/\s+/)[0];
  if (language(oldLines[0], opener[1]) !== language(nextLines[0], nextOpener[1])) return null;
  const nextClosed =
    nextLines.length > 1 && isCloser(nextLines[nextLines.length - 1], nextOpener[1]);
  const content = nextLines.slice(1, nextClosed ? -1 : undefined);
  if (content.some((l) => isCloser(l, opener[1]))) return null;
  const closer = oldLines[oldLines.length - 1];
  const oldClosed = oldLines.length > 1 && isCloser(closer, opener[1]);
  return [oldLines[0], ...content, ...(oldClosed ? [closer] : [])].join(eol);
}

function textOf(
  oldBody: string,
  oldBlocks: readonly PlanBlock[],
  item: SpliceItem,
  eol: Eol,
): string {
  if (item.kind === 'keep') {
    const block = oldBlocks[item.oldIndex];
    return oldBody.slice(block.start, block.end);
  }
  const source = item.source.replace(/[\r\n]+$/, '');
  const old = item.replaces === undefined ? undefined : oldBlocks[item.replaces];
  const rewrapped = old ? rewrapFence(oldBody.slice(old.start, old.end), source, eol) : null;
  return rewrapped ?? source.replace(/\r?\n/g, eol);
}

/** Where an item sits among the old blocks, if anywhere. */
const oldIndexOf = (item: SpliceItem): number | undefined =>
  item.kind === 'keep' ? item.oldIndex : item.replaces;

function joinOf(
  oldBody: string,
  oldBlocks: readonly PlanBlock[],
  left: SpliceItem,
  right: SpliceItem,
  eol: Eol,
): string {
  const l = oldIndexOf(left);
  const r = oldIndexOf(right);
  if (l === undefined || r === undefined || r !== l + 1) return `${eol}${eol}`;
  return oldBody.slice(oldBlocks[l].end, oldBlocks[r].start);
}

export function spliceBody(
  oldBody: string,
  oldBlocks: readonly PlanBlock[],
  items: readonly SpliceItem[],
): string {
  if (items.length === 0) return '';
  const eol = dominantEol(oldBody);

  let out = textOf(oldBody, oldBlocks, items[0], eol);
  for (let i = 1; i < items.length; i++) {
    out += joinOf(oldBody, oldBlocks, items[i - 1], items[i], eol);
    out += textOf(oldBody, oldBlocks, items[i], eol);
  }
  return `${out.replace(/(\r?\n)+$/, '')}${eol}`;
}

export function keepMap(prev: readonly object[], next: readonly object[]): (number | null)[] {
  const n = prev.length;
  const m = next.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        prev[i] === next[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: (number | null)[] = new Array(m).fill(null);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prev[i] === next[j]) {
      out[j] = i;
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}
