import { describe, expect, it } from 'vitest';
import {
  initialTermSearchState,
  type TermSearchState,
  termSearchReducer,
} from '../../webview/term-search';

const open = (q = ''): TermSearchState =>
  termSearchReducer(termSearchReducer(initialTermSearchState, { type: 'open' }), {
    type: 'setQuery',
    query: q,
  });

describe('termSearchReducer', () => {
  it('starts closed with an empty query', () => {
    expect(initialTermSearchState).toEqual({ open: false, query: '', direction: 'next' });
  });

  it('open shows the bar and preserves the existing query', () => {
    const withQuery = open('err');
    const reopened = termSearchReducer(
      termSearchReducer(withQuery, { type: 'close' }),
      // re-open after a close starts clean (close reset the query)…
      { type: 'open' },
    );
    expect(reopened.open).toBe(true);
    expect(reopened.query).toBe('');

    // …but re-opening WITHOUT closing keeps the query.
    const reopenedNoClose = termSearchReducer(withQuery, { type: 'open' });
    expect(reopenedNoClose.open).toBe(true);
    expect(reopenedNoClose.query).toBe('err');
  });

  it('close hides the bar and resets to the initial state', () => {
    const closed = termSearchReducer(open('boom'), { type: 'close' });
    expect(closed).toEqual(initialTermSearchState);
  });

  it('setQuery updates the query and resets direction to next', () => {
    const prevd = termSearchReducer(open('x'), { type: 'prev' });
    expect(prevd.direction).toBe('prev');
    const typed = termSearchReducer(prevd, { type: 'setQuery', query: 'xy' });
    expect(typed.query).toBe('xy');
    expect(typed.direction).toBe('next');
  });

  it('next/prev set the navigation direction', () => {
    const s = open('warn');
    expect(termSearchReducer(s, { type: 'next' }).direction).toBe('next');
    expect(termSearchReducer(s, { type: 'prev' }).direction).toBe('prev');
  });

  it('next/prev are no-ops on an empty query', () => {
    const s = open('');
    expect(termSearchReducer(s, { type: 'next' })).toBe(s);
    expect(termSearchReducer(s, { type: 'prev' })).toBe(s);
  });

  it('is a pure function (same state+action → same result)', () => {
    const s = open('q');
    expect(termSearchReducer(s, { type: 'next' })).toEqual(termSearchReducer(s, { type: 'next' }));
  });

  it('preserves the query across navigation', () => {
    const s = open('grep');
    expect(termSearchReducer(s, { type: 'prev' }).query).toBe('grep');
    expect(termSearchReducer(s, { type: 'next' }).query).toBe('grep');
  });
});
