/**
 * Utilities for revealing a search-match line in the rendered Markdown view (D7).
 *
 * Two exports:
 *   - `rehypeSourceLine`   — rehype plugin: stamps each block-level element with a
 *                            `data-source-line` attribute from the HAST node's position.
 *   - `findBlockForLine`   — pure helper: given a list of source-line descriptors and a
 *                            1-based target line, returns the index of the block that
 *                            best covers (or is nearest before) the target.
 */

// ─── Minimal types for the HAST tree nodes we need to traverse ───────────────
// We define just the subset of HAST we use so we don't need to add `hast` as a
// listed dependency in package.json.
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

// ─── Block-level element names that carry source-line annotations ─────────────
// Only top-level block containers are tagged; inline elements like <em>/<strong>
// would create noise and are skipped.
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

/** Lightweight recursive walker — avoids a dependency on `unist-util-visit`. */
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
 * Rehype plugin — adds `data-source-line` to block-level HAST elements using
 * the position information that remark-rehype preserves from the MDAST.
 *
 * Usage: add to `rehypePlugins` in `<ReactMarkdown>`.
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

/**
 * Descriptor for a rendered block, sourced from DOM `data-source-line` attributes.
 */
export interface BlockDescriptor {
  /** 1-based source line where this block starts in the markdown source. */
  sourceLine: number;
}

/**
 * Given a list of block descriptors (sorted ascending by `sourceLine`) and a
 * 1-based target line, returns the index of the block whose source range best
 * covers the target. Strategy:
 *
 * - Find the last block whose `sourceLine` ≤ targetLine (the block that
 *   *contains or precedes* the line in source).
 * - If the target is before all blocks (targetLine < first block's sourceLine),
 *   return 0 (scroll to the very first block).
 * - Returns -1 for an empty list.
 *
 * This is a pure function — no DOM, no side effects — so it is unit-testable
 * without jsdom.
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
