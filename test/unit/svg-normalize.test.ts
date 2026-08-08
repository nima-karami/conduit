import { describe, expect, it } from 'vitest';
import { normalizeSvgForZoom } from '../../webview/svg-normalize';

describe('normalizeSvgForZoom — root attributes', () => {
  it('removes width/height attributes from the root svg', () => {
    const out = normalizeSvgForZoom(
      '<svg width="100%" height="174" viewBox="0 0 111 174"><g/></svg>',
    );
    expect(out).toBe('<svg viewBox="0 0 111 174"><g/></svg>');
  });

  it('keeps viewBox, id, class, role and aria-* untouched', () => {
    const src =
      '<svg id="dmermaid-1" class="flowchart" role="graphics-document document" aria-roledescription="flowchart-v2" aria-label="Chart" width="8" height="9" viewBox="0 0 4 5"></svg>';
    expect(normalizeSvgForZoom(src)).toBe(
      '<svg id="dmermaid-1" class="flowchart" role="graphics-document document" aria-roledescription="flowchart-v2" aria-label="Chart" viewBox="0 0 4 5"></svg>',
    );
  });

  it('tolerates single quotes and unquoted values', () => {
    expect(normalizeSvgForZoom("<svg width='100%' height=174 viewBox='0 0 1 2'></svg>")).toBe(
      "<svg viewBox='0 0 1 2'></svg>",
    );
  });

  it('tolerates a self-closing root tag', () => {
    expect(normalizeSvgForZoom('<svg width="10" height="20" viewBox="0 0 1 2"/>')).toBe(
      '<svg viewBox="0 0 1 2"/>',
    );
  });

  it('tolerates a multi-line root tag', () => {
    const src = `<svg
  width="100%"
  height="240"
  viewBox="0 0 120 240"
>
  <rect width="10" height="10"/>
</svg>`;
    const out = normalizeSvgForZoom(src);
    expect(out).toContain('viewBox="0 0 120 240"');
    expect(out).toContain('<rect width="10" height="10"/>');
    expect(out.slice(0, out.indexOf('>'))).not.toMatch(/\bwidth=/);
    expect(out.slice(0, out.indexOf('>'))).not.toMatch(/\bheight=/);
  });

  it('leaves hyphenated attributes that merely end in width/height alone', () => {
    const src = '<svg stroke-width="2" data-height="9" viewBox="0 0 1 1"></svg>';
    expect(normalizeSvgForZoom(src)).toBe(src);
  });

  it('is case-insensitive about the attribute names', () => {
    expect(normalizeSvgForZoom('<svg WIDTH="4" Height="5" viewBox="0 0 1 1"></svg>')).toBe(
      '<svg viewBox="0 0 1 1"></svg>',
    );
  });
});

describe('normalizeSvgForZoom — inline style', () => {
  it('strips only the max-width declaration', () => {
    expect(
      normalizeSvgForZoom(
        '<svg style="max-width: 111.45px; background-color: white;" viewBox="0 0 1 1"></svg>',
      ),
    ).toBe('<svg style="background-color: white" viewBox="0 0 1 1"></svg>');
  });

  it('strips a max-width sitting in the middle of the declaration list', () => {
    expect(
      normalizeSvgForZoom(
        '<svg style="color: red; max-width: 20px; background: blue" viewBox="0 0 1 1"></svg>',
      ),
    ).toBe('<svg style="color: red; background: blue" viewBox="0 0 1 1"></svg>');
  });

  it('drops the style attribute entirely when max-width was its only declaration', () => {
    expect(normalizeSvgForZoom('<svg style="max-width: 20px;" viewBox="0 0 1 1"></svg>')).toBe(
      '<svg viewBox="0 0 1 1"></svg>',
    );
  });

  it('leaves a style with no max-width byte-identical', () => {
    const src = '<svg style="background-color:white;   color: red;" viewBox="0 0 1 1"></svg>';
    expect(normalizeSvgForZoom(src)).toBe(src);
  });

  it('does not confuse a width declaration for max-width', () => {
    const src = '<svg style="width: 10px" viewBox="0 0 1 1"></svg>';
    expect(normalizeSvgForZoom(src)).toBe(src);
  });

  it('handles a single-quoted style attribute', () => {
    expect(
      normalizeSvgForZoom("<svg style='max-width:20px;color:red' viewBox='0 0 1 1'></svg>"),
    ).toBe("<svg style='color:red' viewBox='0 0 1 1'></svg>");
  });
});

describe('normalizeSvgForZoom — scope and no-ops', () => {
  it('is a no-op when neither max-width nor width/height is present', () => {
    const src = '<svg viewBox="0 0 111 174" class="x"><g><rect x="1"/></g></svg>';
    expect(normalizeSvgForZoom(src)).toBe(src);
  });

  it('never touches the body, even when it contains width= and max-width', () => {
    const src =
      '<svg width="9" viewBox="0 0 1 1"><rect width="10" height="10" style="max-width: 4px"/><text>width=</text></svg>';
    expect(normalizeSvgForZoom(src)).toBe(
      '<svg viewBox="0 0 1 1"><rect width="10" height="10" style="max-width: 4px"/><text>width=</text></svg>',
    );
  });

  it('keeps leading markup before the root svg (xml prolog / comment)', () => {
    const src = '<!-- c --><svg width="3" viewBox="0 0 1 1"></svg>';
    expect(normalizeSvgForZoom(src)).toBe('<!-- c --><svg viewBox="0 0 1 1"></svg>');
  });

  it('returns the input unchanged when there is no svg element at all', () => {
    expect(normalizeSvgForZoom('<div>nope</div>')).toBe('<div>nope</div>');
    expect(normalizeSvgForZoom('')).toBe('');
  });

  it('does not mistake a > inside an attribute value for the end of the tag', () => {
    const src = '<svg aria-label="a > b" width="4" viewBox="0 0 1 1"></svg>';
    expect(normalizeSvgForZoom(src)).toBe('<svg aria-label="a > b" viewBox="0 0 1 1"></svg>');
  });
});
