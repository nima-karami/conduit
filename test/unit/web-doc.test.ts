import { describe, expect, it } from 'vitest';
import { docsReducer, initialDocs } from '../../webview/docs';

const URL = 'https://example.com/docs';

describe('docsReducer — web docs', () => {
  it('opens a web doc with id web:<url> and a host/path title', () => {
    const s = docsReducer(initialDocs, { type: 'open', kind: 'web', path: URL, sessionId: 's1' });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(`web:${URL}`);
    expect(s.docs[0].kind).toBe('web');
    expect(s.docs[0].title).toBe('example.com/docs');
    expect(s.activeId).toBe(`web:${URL}`);
  });

  it('setTitle adopts the live page title', () => {
    let s = docsReducer(initialDocs, { type: 'open', kind: 'web', path: URL, sessionId: 's1' });
    s = docsReducer(s, { type: 'setTitle', id: `web:${URL}`, title: 'Example Docs' });
    expect(s.docs[0].title).toBe('Example Docs');
  });

  it('setTitle ignores empty/whitespace titles and unknown ids', () => {
    let s = docsReducer(initialDocs, { type: 'open', kind: 'web', path: URL, sessionId: 's1' });
    const before = s;
    s = docsReducer(s, { type: 'setTitle', id: `web:${URL}`, title: '   ' });
    expect(s.docs[0].title).toBe('example.com/docs');
    s = docsReducer(s, { type: 'setTitle', id: 'web:nope', title: 'x' });
    expect(s).toBe(before); // no-op returns the same state reference
  });

  it('re-opening the same URL transfers ownership, not a duplicate tab', () => {
    let s = docsReducer(initialDocs, { type: 'open', kind: 'web', path: URL, sessionId: 's1' });
    s = docsReducer(s, { type: 'open', kind: 'web', path: URL, sessionId: 's2' });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].sessionId).toBe('s2');
  });
});
