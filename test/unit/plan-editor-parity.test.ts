// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { splitPlan } from '../../src/plan-blocks';
import { PlanEditor, type PlanEditorHandle } from '../../webview/components/plan-editor';

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

async function mount(
  body: string,
): Promise<{ container: HTMLDivElement; handle: RefObject<PlanEditorHandle | null> }> {
  const handle = createRef<PlanEditorHandle>();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(PlanEditor, {
        ref: handle,
        body,
        readOnly: false,
        onBody: () => {},
        onBodyRefused: () => {},
        onBlockFocus: () => {},
        agentChanged: new Set<string>(),
      }),
    );
  });
  await settle(host);
  return { container: host, handle };
}

describe('PlanEditor', () => {
  it('Milkdown mounts under React 19 and renders a code_block node view for the fixture', async () => {
    const { container } = await mount(splitPlan(fixture).body);

    expect(container.querySelector('[data-milkdown-root]')).not.toBeNull();
    expect(container.querySelectorAll('textarea')).toHaveLength(2);
  });

  it('the code_block node view carries the fence language and its text', async () => {
    const { container } = await mount(splitPlan(fixture).body);
    const langs = [...container.querySelectorAll('textarea')].map((t) => t.dataset.lang);

    expect(langs).toEqual(['ts', 'mermaid']);
    expect(container.querySelector('textarea')?.value).toContain('export function createIdentity');
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
