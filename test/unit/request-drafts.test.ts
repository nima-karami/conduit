// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  clearDraft,
  getDraft,
  type RequestDraft,
  setDraft,
  useDraft,
} from '../../webview/request-drafts';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  clearDraft('r1');
  clearDraft('r2');
});

describe('request drafts', () => {
  it('a draft survives close and reopen', async () => {
    const draft: RequestDraft = { pick: ['yes'], text: 'half typed' };
    const host = document.createElement('div');
    const root = createRoot(host);
    const seen: (RequestDraft | undefined)[] = [];
    function Panel() {
      seen.push(useDraft('r1'));
      return null;
    }

    await act(async () => {
      root.render(createElement(Panel));
    });
    await act(async () => {
      setDraft('r1', draft);
    });
    await act(async () => {
      root.unmount();
    });

    expect(getDraft('r1')).toEqual(draft);

    const reopened = createRoot(document.createElement('div'));
    await act(async () => {
      reopened.render(createElement(Panel));
    });
    expect(seen[seen.length - 1]).toEqual(draft);
    await act(async () => {
      reopened.unmount();
    });
  });

  it('clearDraft removes it', () => {
    setDraft('r1', { pick: [], text: 'x' });
    clearDraft('r1');
    expect(getDraft('r1')).toBeUndefined();
  });

  it('subscribers are told on set', async () => {
    const root = createRoot(document.createElement('div'));
    const seen: (RequestDraft | undefined)[] = [];
    function Panel() {
      seen.push(useDraft('r2'));
      return null;
    }
    await act(async () => {
      root.render(createElement(Panel));
    });
    expect(seen[seen.length - 1]).toBeUndefined();

    const next: RequestDraft = { pick: ['a'], text: '' };
    await act(async () => {
      setDraft('r2', next);
    });
    expect(seen[seen.length - 1]).toEqual(next);
    await act(async () => {
      root.unmount();
    });
  });
});
