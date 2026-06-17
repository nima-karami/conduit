/**
 * Utilities for revealing a search-match line in the rendered Markdown view (D7).
 */

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
