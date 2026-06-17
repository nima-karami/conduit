/**
 * Pure helpers for the VS Code-style breadcrumb bar (E3).
 * Browser-safe: NO node:path imports.
 */

/** One breadcrumb path segment. `dirPath` is the absolute dir to readDir for the dropdown. */
export interface BreadcrumbPathSegment {
  /** Display name (dir name or file name). */
  name: string;
  /** Absolute directory path for this segment's sibling dropdown. */
  dirPath: string;
}

/**
 * Normalise a path to forward-slash form, stripping any leading slashes.
 * Converts Windows backslashes and handles drive letters like `G:/foo`.
 */
function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Split a path into non-empty parts. Handles both POSIX and Windows separators.
 * `G:/awby/foo` → ['G:', 'awby', 'foo']
 * `/usr/local/bin` → ['usr', 'local', 'bin']
 */
function splitParts(p: string): string[] {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0);
}

/**
 * Build ordered breadcrumb path segments for a file, relative to rootCwd when the
 * file lives under it, or using the file's own path segments when it doesn't.
 *
 * @param filePath - Absolute file path (Windows or POSIX).
 * @param rootCwd - Root directory (absolute) to relativize against.
 * @returns Ordered segments from rootCwd (or fs root) down to the file.
 *          Each segment's `dirPath` is the absolute dir to readDir for the dropdown.
 */
export function breadcrumbPathSegments(filePath: string, rootCwd: string): BreadcrumbPathSegment[] {
  const fileNorm = normalise(filePath);
  const rootNorm = normalise(rootCwd).replace(/\/$/, '');

  // Determine whether the path has a Windows drive letter prefix (e.g. 'G:').
  // After normalise, it appears as the first component from splitParts.
  const driveMatch = fileNorm.match(/^([A-Za-z]:)\//);
  const drivePrefix = driveMatch ? driveMatch[1] : ''; // e.g. 'G:' or ''

  // All path parts including the drive letter component (if any).
  const fileParts = splitParts(fileNorm);
  if (fileParts.length === 0) return [];

  // Helper: reconstruct an absolute path from full split parts (including drive if any).
  // parts[0] may be the drive letter 'G:'; we treat it just like any other component
  // in the join, then prepend a '/' for POSIX paths.
  const absFromParts = (parts: string[]): string => {
    if (parts.length === 0) {
      // Root of the tree.
      return drivePrefix ? `${drivePrefix}/` : '/';
    }
    const joined = parts.join('/');
    // Windows: parts[0] = 'G:' so joined = 'G:/awby/...' — correct, no extra prefix.
    // POSIX: parts[0] = 'home', joined = 'home/...' — needs a leading '/'.
    return drivePrefix ? joined : `/${joined}`;
  };

  // Determine whether the file is inside rootCwd.
  const isInside =
    rootNorm.length > 0 && (fileNorm === rootNorm || fileNorm.startsWith(`${rootNorm}/`));

  let segmentParts: string[]; // the display parts we'll show as breadcrumb segments

  if (isInside) {
    // Show path relative to rootCwd.
    // e.g. rootCwd='G:/awby/conduit' → rootParts=['G:','awby','conduit']
    // file='G:/awby/conduit/src/foo.ts' → fileParts=['G:','awby','conduit','src','foo.ts']
    // relParts = ['src', 'foo.ts']
    const rootParts = splitParts(rootNorm);
    segmentParts = fileParts.slice(rootParts.length);
  } else {
    // File is outside rootCwd: show all parts of the file's path.
    segmentParts = fileParts;
  }

  if (segmentParts.length === 0) return [];

  // Build a segment for each display part.
  // For display part at index `i`, its "parent dir" is at absolute index
  // (rootPartCount + i) within fileParts, so parentParts = dirParts up to that index.
  const rootPartCount = isInside ? splitParts(rootNorm).length : 0;
  const result: BreadcrumbPathSegment[] = [];

  for (let i = 0; i < segmentParts.length; i++) {
    const name = segmentParts[i];
    const absoluteIndex = rootPartCount + i;
    // parentParts = all components before this segment in the full fileParts array.
    const parentParts = fileParts.slice(0, absoluteIndex);
    const dirPath = absFromParts(parentParts);
    result.push({ name, dirPath });
  }

  return result;
}

// ---------- Symbol chain ----------

/** A navigation tree node (TS worker `getNavigationTree` shape). */
export interface NavTreeNode {
  text: string;
  kind: string;
  spans: Array<{ start: number; length: number }>;
  childItems?: NavTreeNode[];
}

/** One symbol in the enclosing chain. `siblings` includes the symbol itself. */
export interface SymbolChainItem {
  text: string;
  kind: string;
  /** Character offset of the start of this symbol (for reveal). */
  start: number;
  /** All symbols at the same level (for the dropdown). */
  siblings: Array<{ text: string; kind: string; start: number }>;
}

/**
 * Given the TS worker's navigation tree and a cursor character offset (0-based),
 * return the chain of symbols that enclose that offset (outermost → innermost),
 * each with its siblings at that level.
 *
 * Returns [] when no tree is provided, the offset matches no symbol, or the tree
 * is empty.
 */
export function enclosingSymbolChain(
  navTree: NavTreeNode | null | undefined,
  offset: number,
): SymbolChainItem[] {
  if (!navTree?.childItems || navTree.childItems.length === 0) return [];
  return walkLevel(navTree.childItems, offset);
}

/** Check whether a span contains an offset. */
function spanContains(span: { start: number; length: number }, offset: number): boolean {
  return offset >= span.start && offset < span.start + span.length;
}

/** Build a sibling list from a set of same-level nodes. */
function makeSiblings(nodes: NavTreeNode[]): Array<{ text: string; kind: string; start: number }> {
  return nodes
    .filter((n) => n.spans.length > 0)
    .map((n) => ({ text: n.text, kind: n.kind, start: n.spans[0].start }));
}

function walkLevel(nodes: NavTreeNode[], offset: number): SymbolChainItem[] {
  const siblings = makeSiblings(nodes);
  for (const node of nodes) {
    const containing = node.spans.find((s) => spanContains(s, offset));
    if (containing) {
      const item: SymbolChainItem = {
        text: node.text,
        kind: node.kind,
        start: node.spans[0].start,
        siblings,
      };
      if (node.childItems && node.childItems.length > 0) {
        const deeper = walkLevel(node.childItems, offset);
        return [item, ...deeper];
      }
      return [item];
    }
  }
  return [];
}
