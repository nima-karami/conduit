import type { PlanBlock } from './plan-blocks';

export type SpliceItem = { kind: 'keep'; oldIndex: number } | { kind: 'new'; source: string };

const JOIN = '\n\n';

function textOf(oldBody: string, oldBlocks: readonly PlanBlock[], item: SpliceItem): string {
  if (item.kind === 'new') return item.source.replace(/[\r\n]+$/, '');
  const block = oldBlocks[item.oldIndex];
  return oldBody.slice(block.start, block.end);
}

function joinOf(
  oldBody: string,
  oldBlocks: readonly PlanBlock[],
  left: SpliceItem,
  right: SpliceItem,
): string {
  if (left.kind !== 'keep' || right.kind !== 'keep') return JOIN;
  if (right.oldIndex !== left.oldIndex + 1) return JOIN;
  return oldBody.slice(oldBlocks[left.oldIndex].end, oldBlocks[right.oldIndex].start);
}

export function spliceBody(
  oldBody: string,
  oldBlocks: readonly PlanBlock[],
  items: readonly SpliceItem[],
): string {
  if (items.length === 0) return '';

  let out = textOf(oldBody, oldBlocks, items[0]);
  for (let i = 1; i < items.length; i++) {
    out += joinOf(oldBody, oldBlocks, items[i - 1], items[i]);
    out += textOf(oldBody, oldBlocks, items[i]);
  }
  return `${out.replace(/\n+$/, '')}\n`;
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
