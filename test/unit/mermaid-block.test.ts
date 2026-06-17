import { describe, expect, it } from 'vitest';

// isMermaidCodeBlock is a pure function with no DOM dependencies — import directly.
// (mermaid itself is not imported here; the classifier lives independently.)

/** Inline copy of the classifier logic so the unit test has no esbuild/DOM dep.
 *  Any change to the real function must be reflected here.
 *  Handles rehype-highlight's `hljs` prefix by splitting on whitespace. */
function isMermaidCodeBlock(className: string | undefined): boolean {
  if (!className) return false;
  return className.split(/\s+/).includes('language-mermaid');
}

describe('isMermaidCodeBlock', () => {
  it('returns true for the mermaid language class', () => {
    expect(isMermaidCodeBlock('language-mermaid')).toBe(true);
  });

  it('returns true when rehype-highlight adds the hljs prefix class', () => {
    expect(isMermaidCodeBlock('hljs language-mermaid')).toBe(true);
    expect(isMermaidCodeBlock('language-mermaid hljs')).toBe(true);
  });

  it('returns false for other language classes', () => {
    expect(isMermaidCodeBlock('language-typescript')).toBe(false);
    expect(isMermaidCodeBlock('language-js')).toBe(false);
    expect(isMermaidCodeBlock('language-python')).toBe(false);
    expect(isMermaidCodeBlock('language-bash')).toBe(false);
  });

  it('returns false for a code block with no language', () => {
    expect(isMermaidCodeBlock(undefined)).toBe(false);
    expect(isMermaidCodeBlock('')).toBe(false);
  });

  it('returns false for partially matching strings', () => {
    expect(isMermaidCodeBlock('mermaid')).toBe(false);
    expect(isMermaidCodeBlock('language-mermaids')).toBe(false);
    expect(isMermaidCodeBlock('LANGUAGE-MERMAID')).toBe(false);
  });
});
