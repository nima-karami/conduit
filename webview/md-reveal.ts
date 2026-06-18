/**
 * Utilities for revealing a search-match line in the rendered Markdown view (D7),
 * plus stable heading-id stamping for anchors + the document outline.
 */

import { SlugFactory } from './slugify';

// Minimal subset of HAST we traverse, defined inline to avoid listing `hast` as a dep.
interface HastPosition {
  start: { line: number; column: number };
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  position?: HastPosition;
  children?: HastNode[];
}
interface HastText {
  type: 'text';
  value: string;
}
interface HastRoot {
  type: 'root';
  children?: HastNode[];
}
type HastNode = HastElement | HastText | HastRoot | { type: string; children?: HastNode[] };

// Only block containers are tagged; inline elements (<em>/<strong>) would add noise.
const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'table',
  'hr',
  'div',
]);

/** Recursive walker — avoids a dependency on `unist-util-visit`. */
function walkElements(node: HastNode, visitor: (el: HastElement) => void): void {
  if (node.type === 'element') {
    visitor(node as HastElement);
  }
  const children = (node as { children?: HastNode[] }).children;
  if (children) {
    for (const child of children) {
      walkElements(child, visitor);
    }
  }
}

/**
 * Rehype plugin — stamps `data-source-line` on block-level HAST elements from the
 * position info remark-rehype preserves. Add to `rehypePlugins` in `<ReactMarkdown>`.
 */
export function rehypeSourceLine() {
  return (tree: HastRoot): void => {
    walkElements(tree, (node) => {
      if (!BLOCK_TAGS.has(node.tagName)) return;
      const line = node.position?.start?.line;
      if (typeof line === 'number') {
        node.properties = node.properties ?? {};
        node.properties['data-source-line'] = line;
      }
    });
  };
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Concatenate the text of a HAST subtree (heading label, ignoring inline markup). */
function hastText(node: HastNode): string {
  if (node.type === 'text') return (node as HastText).value;
  const children = (node as { children?: HastNode[] }).children;
  return children ? children.map(hastText).join('') : '';
}

/**
 * Rehype plugin — stamps a slugified `id` on each heading from its text. Generating
 * ids in the AST pass (one fresh SlugFactory per traversal) keeps them deterministic
 * and stable across React re-renders; doing it in the heading components instead made
 * a render-scoped factory re-suffix ids every render. Add to `rehypePlugins`.
 */
export function rehypeHeadingIds() {
  return (tree: HastRoot): void => {
    const factory = new SlugFactory();
    walkElements(tree, (node) => {
      if (!HEADING_TAGS.has(node.tagName)) return;
      node.properties = node.properties ?? {};
      if (node.properties.id) return; // respect an explicit id
      const text = hastText(node).trim();
      if (text) node.properties.id = factory.slug(text);
    });
  };
}

export interface BlockDescriptor {
  /** 1-based source line where this block starts in the markdown source. */
  sourceLine: number;
}

/**
 * Index of the block best covering a 1-based `targetLine`, given descriptors sorted
 * ascending by `sourceLine`: the last block with `sourceLine` ≤ target (0 if the target
 * precedes all blocks, -1 for an empty list).
 */
export function findBlockForLine(blocks: BlockDescriptor[], targetLine: number): number {
  if (blocks.length === 0) return -1;
  let best = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].sourceLine <= targetLine) {
      best = i;
    } else {
      break;
    }
  }
  return best;
}
