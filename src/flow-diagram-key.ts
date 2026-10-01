const FLOWCHART_RE = /^(flowchart|graph)\b/;

/**
 * `"flow-" + ordinal` per flowchart fence, `null` for every other fence. Counted whether or not the
 * fence parses, so editing one as text does not shift the others' keys — spec §3.1.
 */
export function flowDiagramKeys(
  fences: readonly { language: string; text: string }[],
): (string | null)[] {
  let ordinal = 0;
  return fences.map((f) => {
    if (f.language !== 'mermaid') return null;
    const head = f.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('%%'));
    return head !== undefined && FLOWCHART_RE.test(head) ? `flow-${ordinal++}` : null;
  });
}
