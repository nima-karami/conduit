import { describe, expect, it, vi } from 'vitest';
import { goToChangeInActiveDoc, registerChangeNav } from '../../webview/change-nav-registry';

const docs = [{ id: 'file:/a.ts', path: '/a.ts' }];

function entry() {
  return { next: vi.fn(), prev: vi.fn(), hasChanges: () => true };
}

describe('change-nav-registry — two viewers on one path (split-editor D1)', () => {
  it('second viewer on the same path: unmounting the newer one leaves the survivor registered', () => {
    const a = entry();
    const b = entry();
    const offA = registerChangeNav('/a.ts', a);
    const offB = registerChangeNav('/a.ts', b);
    offB();
    goToChangeInActiveDoc(docs, 'file:/a.ts', 'next');
    expect(a.next).toHaveBeenCalledTimes(1);
    offA();
  });
});
