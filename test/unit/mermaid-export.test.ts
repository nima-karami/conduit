import { describe, expect, it } from 'vitest';
import { diagramFilename, normalizeSvgMarkup, svgToBlob } from '../../webview/mermaid-export';

// A minimal stand-in for the markup mermaid.render emits: an <svg> with a viewBox but
// (as mermaid does) no <?xml prolog. PNG rasterization needs a real canvas/Image and is
// covered by test/e2e/mermaid-export.e2e.mjs, not here (jsdom has no canvas).
const SAMPLE_SVG = '<svg id="d" viewBox="0 0 100 80"><g><rect width="10" height="10" /></g></svg>';

describe('svgToBlob', () => {
  it('produces a non-empty image/svg+xml blob containing the markup', async () => {
    const blob = svgToBlob(SAMPLE_SVG);
    expect(blob.type).toBe('image/svg+xml');
    expect(blob.size).toBeGreaterThan(0);
    const text = await blob.text();
    expect(text).toContain('<svg');
    expect(text).toContain('rect');
  });

  it('injects an xmlns and an XML prolog so the file opens standalone', async () => {
    const text = await svgToBlob(SAMPLE_SVG).text();
    expect(text.startsWith('<?xml')).toBe(true);
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});

describe('normalizeSvgMarkup', () => {
  it('is idempotent — an already-standalone document is a fixed point', () => {
    const already =
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    const out = normalizeSvgMarkup(already);
    expect(out.match(/<\?xml/g)?.length).toBe(1);
    expect(out.match(/xmlns=/g)?.length).toBe(1);
    expect(normalizeSvgMarkup(out)).toBe(out);
  });
});

describe('diagramFilename', () => {
  it('builds diagram.<ext>', () => {
    expect(diagramFilename('svg')).toBe('diagram.svg');
    expect(diagramFilename('png')).toBe('diagram.png');
  });

  it('tolerates a leading dot on the extension', () => {
    expect(diagramFilename('.svg')).toBe('diagram.svg');
  });
});
