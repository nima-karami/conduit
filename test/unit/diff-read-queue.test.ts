import { describe, expect, it, vi } from 'vitest';
import { createDiffReadQueue, diffReadTargets } from '../../webview/diff-read-queue';
import { diffTabKey } from '../../webview/diff-tab-scope';
import type { OpenDoc } from '../../webview/docs';

const A = { path: '/r/a.ts' };
const keyA = diffTabKey(A);

describe('diff-read-queue', () => {
  it('two requests while one is in flight produce one re-post', () => {
    const send = vi.fn();
    const q = createDiffReadQueue(send);
    q.request(A);
    q.request(A);
    q.request(A);
    expect(send).toHaveBeenCalledTimes(1);
    q.settle(keyA);
    expect(send).toHaveBeenCalledTimes(2);
    q.settle(keyA);
    expect(send).toHaveBeenCalledTimes(2);
    q.request(A);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('ensure never marks dirty', () => {
    const send = vi.fn();
    const q = createDiffReadQueue(send);
    q.request(A);
    q.ensure(A);
    q.settle(keyA);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ensure posts when idle', () => {
    const send = vi.fn();
    const q = createDiffReadQueue(send);
    q.ensure(A);
    expect(send).toHaveBeenCalledWith(A);
  });

  it('keys are independent per scope', () => {
    const send = vi.fn();
    const q = createDiffReadQueue(send);
    q.request({ path: '/r/a.ts', diffScope: 'staged' });
    q.request({ path: '/r/a.ts', diffScope: 'unstaged' });
    q.request(A);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('settle of an unknown key is a no-op', () => {
    const send = vi.fn();
    const q = createDiffReadQueue(send);
    q.settle(keyA);
    expect(send).not.toHaveBeenCalled();
    q.request(A);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('diffReadTargets dedupes by key and skips non-diff docs', () => {
    const doc = (d: Partial<OpenDoc> & Pick<OpenDoc, 'id' | 'kind' | 'path'>): OpenDoc => ({
      title: '',
      sessionId: 'S1',
      ...d,
    });
    const docs = [
      doc({ id: 'file:/r/a.ts', kind: 'file', path: '/r/a.ts' }),
      doc({ id: 'diff@staged:/r/a.ts', kind: 'diff', path: '/r/a.ts', diffScope: 'staged' }),
      doc({ id: 'diff:/r/a.ts', kind: 'diff', path: '/r/a.ts' }),
      doc({ id: 'diff:/r/a.ts', kind: 'diff', path: '/r/a.ts', sessionId: 'S2' }),
      doc({ id: 'diff:/r/b.ts', kind: 'diff', path: '/r/b.ts' }),
    ];
    expect(diffReadTargets(docs, (d) => d.path === '/r/a.ts')).toEqual([
      { path: '/r/a.ts', diffScope: 'staged' },
      { path: '/r/a.ts' },
    ]);
  });
});
