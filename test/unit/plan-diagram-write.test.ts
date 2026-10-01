// @vitest-environment jsdom
import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { createTimer } from '@milkdown/kit/ctx';
import { history } from '@milkdown/kit/plugin/history';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { undoDepth } from '@milkdown/kit/prose/history';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  locateDiagram,
  writeDiagram,
  writeDiagramText,
  writeFenceTextAt,
} from '../../webview/plan-diagram-write';

const PLAN = [
  '# Plan',
  '',
  '```mermaid',
  'sequenceDiagram',
  'A->>B: hi',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  a --> b',
  '```',
  '',
  '```mermaid',
  'flowchart TD',
  '  x --> y',
  '```',
  '',
].join('\n');

const editors: Editor[] = [];

afterEach(async () => {
  for (const e of editors.splice(0)) await e.destroy();
  document.body.innerHTML = '';
});

// Milkdown arms ctx timers it never clears; jsdom has to outlive them (see plan-editor-parity).
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, createTimer('default').timeout));
  await new Promise((resolve) => setImmediate(resolve));
});

async function mount(markdown: string): Promise<EditorView> {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(history)
    .create();
  editors.push(editor);
  return editor.ctx.get(editorViewCtx);
}

const fenceText = (view: EditorView, key: string) =>
  locateDiagram(view.state.doc, key)?.node.textContent;

describe('writeDiagram', () => {
  it('writes the fence found by key after an earlier block was inserted', async () => {
    const view = await mount(PLAN);
    const before = locateDiagram(view.state.doc, 'flow-1');
    expect(before?.node.textContent).toBe('flowchart TD\n  x --> y');

    const para = view.state.schema.nodes.paragraph.create(null, view.state.schema.text('new'));
    view.dispatch(view.state.tr.insert(0, para));
    expect(locateDiagram(view.state.doc, 'flow-1')?.pos).not.toBe(before?.pos);

    expect(
      writeDiagram(
        view,
        'flow-1',
        [{ op: 'relabelEdge', edge: 0, label: 'go' }],
        fenceText(view, 'flow-1') ?? '',
      ),
    ).toBeNull();
    expect(fenceText(view, 'flow-1')).toBe('flowchart TD\n  x -->|go| y');
    expect(fenceText(view, 'flow-0')).toBe('flowchart LR\n  a --> b');
    expect(view.state.doc.child(0).textContent).toBe('new');
  });

  it('returns gone when the key no longer exists', async () => {
    const view = await mount(PLAN);
    expect(
      writeDiagram(
        view,
        'flow-2',
        [{ op: 'removeEdge', edge: 0 }],
        fenceText(view, 'flow-2') ?? '',
      ),
    ).toBe('gone');
    expect(writeDiagramText(view, 'flow-2', 'flowchart LR')).toBe('gone');
  });

  it('returns the refusal and leaves the document alone', async () => {
    const view = await mount(PLAN);
    const doc = view.state.doc;
    expect(
      writeDiagram(
        view,
        'flow-0',
        [{ op: 'addEdge', source: 'a', target: 'b', kind: 'arrow', label: null }],
        fenceText(view, 'flow-0') ?? '',
      ),
    ).toBe('duplicate-edge');
    expect(view.state.doc).toBe(doc);
  });

  it('returns gone, writing nothing, when the fence is no longer the text the edits were made on', async () => {
    const view = await mount(PLAN);
    const doc = view.state.doc;
    expect(
      writeDiagram(view, 'flow-0', [{ op: 'removeEdge', edge: 0 }], 'flowchart LR\n  a --> c'),
    ).toBe('gone');
    expect(view.state.doc).toBe(doc);
  });

  it('one call = one history event', async () => {
    const view = await mount(PLAN);
    const start = undoDepth(view.state);
    writeDiagram(
      view,
      'flow-0',
      [{ op: 'relabelEdge', edge: 0, label: 'one' }],
      fenceText(view, 'flow-0') ?? '',
    );
    expect(undoDepth(view.state)).toBe(start + 1);
    writeDiagram(
      view,
      'flow-0',
      [{ op: 'relabelEdge', edge: 0, label: 'two' }],
      fenceText(view, 'flow-0') ?? '',
    );
    expect(undoDepth(view.state)).toBe(start + 2);
    writeDiagramText(view, 'flow-0', 'flowchart LR\n  a --> c');
    expect(undoDepth(view.state)).toBe(start + 3);
    expect(fenceText(view, 'flow-0')).toBe('flowchart LR\n  a --> c');
  });

  it('a keyless mermaid fence is written at the position it is handed, never another block', async () => {
    const view = await mount(PLAN);
    let seq = -1;
    view.state.doc.forEach((node, offset) => {
      if (seq < 0 && node.type.name === 'code_block') seq = offset;
    });
    expect(writeFenceTextAt(view, seq, 'sequenceDiagram\nA->>B: bye')).toBeNull();
    expect(view.state.doc.nodeAt(seq)?.textContent).toBe('sequenceDiagram\nA->>B: bye');
    expect(writeFenceTextAt(view, 0, 'nope')).toBe('gone');
  });
});
