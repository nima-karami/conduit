import { describe, expect, it } from 'vitest';
import { tabStateKey } from '../../webview/editor-group-context';

describe('tabStateKey', () => {
  it('tabStateKey is the doc id for group 1 and g2-prefixed for group 2', () => {
    expect(tabStateKey('file:/a.ts', 1)).toBe('file:/a.ts');
    expect(tabStateKey('file:/a.ts', 2)).toBe('g2:file:/a.ts');
  });
});
