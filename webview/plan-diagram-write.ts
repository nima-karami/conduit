// The only fence writer for diagrams. It finds the fence by `diagramKey` in the document as it is
// when called and never holds a position from an earlier render — the plan's Architecture, B1
// (docs/plans/2026-09-30-interactive-plan-v2.plan.md).

import { closeHistory } from '@milkdown/kit/prose/history';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { flowDiagramKeys } from '../src/flow-diagram-key';
import { applyFlowEdits, type FlowEdit, type FlowEditRefusal } from '../src/mermaid-flow-edit';

interface Located {
  pos: number;
  node: ProseNode;
}

function keyedFences(doc: ProseNode): (Located & { key: string | null })[] {
  const found: Located[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true;
    found.push({ pos, node });
    return false;
  });
  const keys = flowDiagramKeys(
    found.map((f) => ({ language: String(f.node.attrs.language ?? ''), text: f.node.textContent })),
  );
  return found.map((f, i) => ({ ...f, key: keys[i] }));
}

export function locateDiagram(doc: ProseNode, key: string): Located | null {
  const hit = keyedFences(doc).find((f) => f.key === key);
  return hit ? { pos: hit.pos, node: hit.node } : null;
}

export function diagramKeyAt(doc: ProseNode, pos: number): string | null {
  return keyedFences(doc).find((f) => f.pos === pos)?.key ?? null;
}

function replaceFence(view: EditorView, at: Located, text: string): void {
  const from = at.pos + 1;
  const to = at.pos + at.node.nodeSize - 1;
  const tr = view.state.tr;
  // An empty ProseMirror text node is illegal, so clearing the fence is a delete.
  const next = text ? tr.replaceWith(from, to, view.state.schema.text(text)) : tr.delete(from, to);
  view.dispatch(closeHistory(next));
}

export function writeDiagram(
  view: EditorView,
  key: string,
  edits: readonly FlowEdit[],
  /** The fence text the edits were computed against; their indices mean nothing on any other. */
  basis: string,
): FlowEditRefusal | 'gone' | null {
  const at = locateDiagram(view.state.doc, key);
  if (!at || at.node.textContent !== basis) return 'gone';
  const result = applyFlowEdits(at.node.textContent, edits);
  if (!result.ok) return result.refusal;
  if (result.source !== at.node.textContent) replaceFence(view, at, result.source);
  return null;
}

export function writeDiagramText(view: EditorView, key: string, text: string): 'gone' | null {
  const at = locateDiagram(view.state.doc, key);
  if (!at) return 'gone';
  if (text !== at.node.textContent) replaceFence(view, at, text);
  return null;
}

/**
 * The text path for a mermaid fence with no `diagramKey` — a sequence diagram, or a flowchart
 * whose header is mid-edit — where the node view's own position, read at call time, is the only
 * identity there is. The node is re-read there too, never carried over from a render.
 */
export function writeFenceTextAt(view: EditorView, pos: number, text: string): 'gone' | null {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type.name !== 'code_block' || node.attrs.language !== 'mermaid') return 'gone';
  if (text !== node.textContent) replaceFence(view, { pos, node }, text);
  return null;
}
