import { describe, expect, it } from 'vitest';
import { groupDocs, previewIdsOf, tabPreview } from '../../webview/doc-groups';
import {
  docsReducer,
  initialDocs,
  requestDocPath,
  requestIdOfPath,
  toPersistedDocs,
} from '../../webview/docs';

describe('request doc paths', () => {
  it('requestDocPath round-trips', () => {
    expect(requestIdOfPath(requestDocPath('req-42'))).toBe('req-42');
    expect(requestIdOfPath('/a.ts')).toBeNull();
    expect(requestIdOfPath('@request/')).toBeNull();
  });
});

describe('request docs', () => {
  it('request docs are not persisted', () => {
    let s = docsReducer(initialDocs, {
      type: 'open',
      kind: 'file',
      path: '/a.ts',
      sessionId: 'S1',
    });
    s = docsReducer(s, {
      type: 'open',
      kind: 'request',
      path: requestDocPath('req-1'),
      sessionId: 'S1',
    });
    expect(groupDocs(s, 'S1', 1).map((d) => d.kind)).toEqual(['file', 'request']);
    expect(toPersistedDocs(s).map((d) => d.kind)).toEqual(['file']);
  });

  it('a request tab is never persisted, while review still is', () => {
    let s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'working' },
    });
    s = docsReducer(s, {
      type: 'open',
      kind: 'request',
      path: requestDocPath('req-1'),
      sessionId: 'S1',
    });
    expect(toPersistedDocs(s).map((d) => d.kind)).toEqual(['review']);
  });

  it('request docs are not previewable', () => {
    const s = docsReducer(initialDocs, {
      type: 'open',
      kind: 'request',
      path: requestDocPath('req-1'),
      sessionId: 'S1',
      mode: 'preview',
    });
    expect(tabPreview(s, 'S1', 1, `request:${requestDocPath('req-1')}`)).toBe(false);
    expect(previewIdsOf(s, 'S1', 1).size).toBe(0);
  });
});
