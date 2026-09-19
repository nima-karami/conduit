import { describe, expect, it } from 'vitest';
import { buildHtmlMenuItems } from '../../webview/html-menu';

describe('buildHtmlMenuItems', () => {
  it('offers Copy disabled without a selection and enabled with one', () => {
    const without = buildHtmlMenuItems({ hasSelection: false }).find((i) => i.id === 'copy');
    const with_ = buildHtmlMenuItems({ hasSelection: true }).find((i) => i.id === 'copy');
    expect(without?.label).toBe('Copy');
    expect(without?.disabled).toBe(true);
    expect(with_?.disabled).toBe(false);
  });

  it('includes the link rows only when a linkURL is present', () => {
    const plain = buildHtmlMenuItems({ hasSelection: false }).map((i) => i.id);
    expect(plain).not.toContain('copyLink');
    expect(plain).not.toContain('openLink');

    const linked = buildHtmlMenuItems({ hasSelection: false, linkURL: 'https://example.com/a' });
    expect(linked.map((i) => i.id)).toContain('copyLink');
    expect(linked.map((i) => i.id)).toContain('openLink');
    expect(linked.find((i) => i.id === 'copyLink')?.label).toBe('Copy link address');
    expect(linked.find((i) => i.id === 'openLink')?.label).toBe('Open link externally');
  });

  it('always offers the page rows, in the content-menu order', () => {
    expect(buildHtmlMenuItems({ hasSelection: true }).map((i) => i.id)).toEqual([
      'copy',
      'selectAll',
      'find',
      'reload',
      'viewSource',
    ]);
    expect(
      buildHtmlMenuItems({ hasSelection: true, linkURL: 'https://example.com/a' }).map((i) => i.id),
    ).toEqual(['copy', 'selectAll', 'copyLink', 'openLink', 'find', 'reload', 'viewSource']);
  });

  it('groups the menu with separators between the families, never inside one', () => {
    const items = buildHtmlMenuItems({ hasSelection: true, linkURL: 'https://example.com/a' });
    const seps = items.filter((i) => i.separatorBefore).map((i) => i.id);
    expect(seps).toEqual(['copyLink', 'find', 'reload']);
  });

  it('never puts a separator on the first rendered item', () => {
    const contexts = [
      { hasSelection: false },
      { hasSelection: true },
      { hasSelection: false, linkURL: 'https://example.com/a' },
      { hasSelection: true, linkURL: 'https://example.com/a' },
      { hasSelection: true, linkURL: '' },
    ];
    for (const ctx of contexts) {
      expect(buildHtmlMenuItems(ctx)[0]?.separatorBefore).toBeFalsy();
    }
  });
});
