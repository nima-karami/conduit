// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { act, createElement, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitPlan } from '../../src/plan-blocks';
import { PlanEditor, type PlanEditorHandle } from '../../webview/components/plan-editor';

/**
 * The two block components are stubbed: the real ones reach `monaco-editor` and `@xyflow/react`,
 * neither of which loads in jsdom, and neither is this file's subject — `test/e2e/plan-blocks.
 * e2e.mjs` drives them for real. The switch that picks between them stays real, so the stubs
 * report which one it mounted.
 */
function blockStub(className: string) {
  return async () => {
    const react = await import('react');
    const adapter = await import('@prosemirror-adapter/react');
    return () => {
      const { node } = adapter.useNodeViewContext();
      return react.createElement('div', {
        className,
        'data-lang': String(node.attrs.language ?? ''),
      });
    };
  };
}

vi.mock('../../webview/components/plan-code-block', async () => ({
  PlanDocContext: (await import('react')).createContext({ root: '', slug: '', readOnly: false }),
  PlanCodeBlock: await blockStub('plan__code')(),
}));

vi.mock('../../webview/components/plan-flow-block', async () => ({
  PlanFlowBlock: await blockStub('planflow')(),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const fixture = readFileSync(
  path.join(__dirname, '..', 'e2e', 'fixtures', 'plan', 'identity.md'),
  'utf8',
);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
});

/**
 * Milkdown creates its editor in an effect that resolves a promise, so the ProseMirror DOM is not
 * there on the render that mounts it. Drain macrotasks until the root has a child.
 */
async function settle(container: HTMLElement): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (container.querySelector('[data-milkdown-root] > *')) return;
  }
}

/** The listener plugin coalesces transactions on its own 200 ms debounce before `updated` fires. */
async function flushListener(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

/** The position at the end of top-level child `index`, inside the node. */
function endOfChild(doc: ProseNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  return pos + doc.child(index).nodeSize - 1;
}

interface Mounted {
  container: HTMLDivElement;
  handle: RefObject<PlanEditorHandle | null>;
  rerender(body: string): Promise<void>;
}

async function mount(body: string, onBody: (next: string) => void = () => {}): Promise<Mounted> {
  const handle = createRef<PlanEditorHandle>();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const render = async (value: string): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(PlanEditor, {
          ref: handle,
          body: value,
          readOnly: false,
          onBody,
          onBodyRefused: () => {},
          onBlockFocus: () => {},
          agentChanged: new Set<string>(),
        }),
      );
    });
  };
  await render(body);
  await settle(host);
  return { container: host, handle, rerender: render };
}

async function insertAtParagraph(
  handle: RefObject<PlanEditorHandle | null>,
  text: string,
): Promise<void> {
  await act(async () => {
    const view = handle.current?.view();
    if (!view) throw new Error('the editor exposed no ProseMirror view');
    view.dispatch(view.state.tr.insertText(text, endOfChild(view.state.doc, 1)));
  });
  await flushListener();
}

describe('PlanEditor', () => {
  it('Milkdown mounts under React 19 and renders a code_block node view for the fixture', async () => {
    const { container } = await mount(splitPlan(fixture).body);

    expect(container.querySelector('[data-milkdown-root]')).not.toBeNull();
    expect(container.querySelectorAll('[data-lang]')).toHaveLength(2);
  });

  it('the node view switch picks the code block for a ts fence and the diagram for mermaid', async () => {
    const { container } = await mount(splitPlan(fixture).body);
    const langs = [...container.querySelectorAll<HTMLElement>('[data-lang]')].map(
      (el) => el.dataset.lang,
    );

    expect(langs).toEqual(['ts', 'mermaid']);
    expect(container.querySelector('.plan__code')?.getAttribute('data-lang')).toBe('ts');
    expect(container.querySelector('.planflow')?.getAttribute('data-lang')).toBe('mermaid');
  });

  it('editing one paragraph emits a body whose other blocks are byte-identical', async () => {
    const original = splitPlan(fixture).body;
    const bodies: string[] = [];
    const { handle } = await mount(original, (next) => bodies.push(next));

    await insertAtParagraph(handle, ' XYZZY');

    expect(bodies).toHaveLength(1);
    const before = splitPlan(original).blocks;
    const after = splitPlan(bodies[0]).blocks;
    expect(after.map((b) => b.kind)).toEqual(before.map((b) => b.kind));
    expect(after[1].source).toContain('XYZZY');
    for (const i of [0, 2, 3, 4]) {
      expect(after[i].source).toBe(before[i].source);
    }
  });

  it('two transactions inside one debounce window splice against the re-based body', async () => {
    const original = splitPlan(fixture).body;
    const bodies: string[] = [];
    const { handle, rerender } = await mount(original, (next) => bodies.push(next));

    await insertAtParagraph(handle, ' ONE');
    // PlanView writes the first body through; the store hands the same bytes back as the prop.
    await rerender(bodies[0]);
    await insertAtParagraph(handle, 'TWO');

    expect(bodies).toHaveLength(2);
    const before = splitPlan(original).blocks;
    const after = splitPlan(bodies[1]).blocks;
    expect(after[1].source).toContain(' ONETWO');
    for (const i of [0, 2, 3, 4]) {
      expect(after[i].source).toBe(before[i].source);
    }
    expect(handle.current?.getBody()).toBe(bodies[1]);
  });
});

const heading = '# Heading';
const paragraphs = 'First paragraph text.\n\nSecond paragraph text.';
const nestedList = '- one\n  - one a\n  - one b\n- two';
const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
const blockquote = '> quoted line\n> second line';
const htmlBlock = '<div>x</div>';
const thematicBreak = '---';
const tsFence = '```ts\nexport const a = 1;\n```';
const mermaidFence = '```mermaid\nflowchart LR\n  a --> b\n```';
const footnote = '[^1]: A footnote body.';
const indentedCode = '    const indented = 1;';
const mathBlock = '$$\nE = mc^2\n$$';

const corpus: [name: string, markdown: string][] = [
  ['fixture', fixture],
  ['heading', heading],
  ['two paragraphs', paragraphs],
  ['nested list', nestedList],
  ['table', table],
  ['blockquote', blockquote],
  ['html block', htmlBlock],
  ['thematic break', thematicBreak],
  ['ts fence', tsFence],
  ['mermaid fence', mermaidFence],
  ['footnote definition', footnote],
  ['indented code block', indentedCode],
  ['math block', mathBlock],
  [
    'combined document',
    [
      heading,
      paragraphs,
      nestedList,
      table,
      blockquote,
      htmlBlock,
      thematicBreak,
      tsFence,
      mermaidFence,
      footnote,
      indentedCode,
      mathBlock,
    ].join('\n\n'),
  ],
];

describe('top-level block count agrees with splitPlan across the corpus', () => {
  for (const [name, markdown] of corpus) {
    it(name, async () => {
      const split = splitPlan(markdown);
      const { handle } = await mount(split.body);

      expect(handle.current?.editorBlockCount()).toBe(split.blocks.length);
    });
  }
});
