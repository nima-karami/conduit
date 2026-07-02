import type { Element, Root } from 'hast';
import { sanitize } from 'hast-util-sanitize';
import { describe, expect, it } from 'vitest';
import { markdownSanitizeSchema } from '../../webview/md-sanitize';

/** Build a minimal hast root wrapping a single `<img>` with the given src. */
function imgRoot(src: string): Root {
  return {
    type: 'root',
    children: [
      { type: 'element', tagName: 'img', properties: { src, alt: 'chart' }, children: [] },
    ],
  };
}

/** Extract the surviving `<img>` (if any) after sanitization. */
function sanitizedImg(src: string): Element | undefined {
  const out = sanitize(imgRoot(src), markdownSanitizeSchema) as Root;
  return out.children.find((c): c is Element => c.type === 'element' && c.tagName === 'img');
}

describe('markdownSanitizeSchema — image src protocols', () => {
  it('keeps a data:image src (the embedded-base64 chart scenario)', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizedImg(src)?.properties?.src).toBe(src);
  });

  it('keeps http(s) image src', () => {
    expect(sanitizedImg('https://example.com/a.png')?.properties?.src).toBe(
      'https://example.com/a.png',
    );
  });

  it('keeps a relative image src (no protocol)', () => {
    expect(sanitizedImg('./out/chart.png')?.properties?.src).toBe('./out/chart.png');
  });

  it('strips a javascript: src (XSS)', () => {
    // The element survives but its dangerous src is removed.
    expect(sanitizedImg('javascript:alert(1)')?.properties?.src).toBeUndefined();
  });
});
