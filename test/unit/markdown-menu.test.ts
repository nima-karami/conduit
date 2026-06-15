import { describe, expect, it } from 'vitest';
import { buildMarkdownMenuItems } from '../../webview/markdown-menu';

describe('buildMarkdownMenuItems', () => {
  it('offers Copy and Select All', () => {
    const ids = buildMarkdownMenuItems({ hasSelection: true }).map((i) => i.id);
    expect(ids).toEqual(['copy', 'selectAll']);
  });

  it('disables Copy when there is no selection', () => {
    const copy = buildMarkdownMenuItems({ hasSelection: false }).find((i) => i.id === 'copy');
    expect(copy?.disabled).toBe(true);
  });

  it('enables Copy when a selection exists', () => {
    const copy = buildMarkdownMenuItems({ hasSelection: true }).find((i) => i.id === 'copy');
    expect(copy?.disabled).toBe(false);
  });

  it('puts a separator before Select All', () => {
    const sa = buildMarkdownMenuItems({ hasSelection: true }).find((i) => i.id === 'selectAll');
    expect(sa?.separatorBefore).toBe(true);
  });
});
