import { describe, expect, it } from 'vitest';
import {
  INITIAL_REVIEW_LAYOUT,
  type ReviewLayoutState,
  reduceReviewLayout,
} from '../../src/review-mode-layout';

const state = (autoOpened: boolean): ReviewLayoutState => Object.freeze({ autoOpened });

describe('reduceReviewLayout', () => {
  it('starts with nothing auto-opened', () => {
    expect(INITIAL_REVIEW_LAYOUT).toEqual({ autoOpened: false });
  });

  it('opens a collapsed explorer on mode on and remembers that it did', () => {
    const r = reduceReviewLayout(state(false), {
      type: 'mode',
      on: true,
      explorerCollapsed: true,
    });
    expect(r.state).toEqual({ autoOpened: true });
    expect(r.effect).toEqual({ setExplorerCollapsed: false, showChanges: true });
  });

  it('only shows changes on mode on when the explorer is already open', () => {
    const r = reduceReviewLayout(state(false), {
      type: 'mode',
      on: true,
      explorerCollapsed: false,
    });
    expect(r.state).toEqual({ autoOpened: false });
    expect(r.effect).toEqual({ showChanges: true });
  });

  it('does nothing on mode off', () => {
    const r = reduceReviewLayout(state(true), {
      type: 'mode',
      on: false,
      explorerCollapsed: true,
    });
    expect(r.state).toEqual({ autoOpened: true });
    expect(r.effect).toEqual({});
  });

  it('forgets the auto-open once the user works the explorer themselves', () => {
    const r = reduceReviewLayout(state(true), { type: 'userToggledExplorer' });
    expect(r.state).toEqual({ autoOpened: false });
    expect(r.effect).toEqual({});
  });

  it('re-collapses the explorer it opened when the review doc closes', () => {
    const r = reduceReviewLayout(state(true), {
      type: 'reviewDocClosed',
      explorerCollapsed: false,
    });
    expect(r.state).toEqual({ autoOpened: false });
    expect(r.effect).toEqual({ setExplorerCollapsed: true });
  });

  it('leaves an explorer it did not open alone when the review doc closes', () => {
    const r = reduceReviewLayout(state(false), {
      type: 'reviewDocClosed',
      explorerCollapsed: false,
    });
    expect(r.state).toEqual({ autoOpened: false });
    expect(r.effect).toEqual({});
  });

  it('emits no restore when the explorer is already collapsed at review-doc close', () => {
    const r = reduceReviewLayout(state(true), {
      type: 'reviewDocClosed',
      explorerCollapsed: true,
    });
    expect(r.state).toEqual({ autoOpened: false });
    expect(r.effect).toEqual({});
  });

  it('sets the memory once when mode turns on twice', () => {
    const first = reduceReviewLayout(INITIAL_REVIEW_LAYOUT, {
      type: 'mode',
      on: true,
      explorerCollapsed: true,
    });
    const second = reduceReviewLayout(first.state, {
      type: 'mode',
      on: true,
      explorerCollapsed: false,
    });
    expect(second.state).toEqual({ autoOpened: true });
    expect(second.effect.setExplorerCollapsed).toBeUndefined();
    expect(second.effect).toEqual({ showChanges: true });
  });

  it('does not mutate the state it is given', () => {
    const before: ReviewLayoutState = { autoOpened: false };
    reduceReviewLayout(before, { type: 'mode', on: true, explorerCollapsed: true });
    expect(before).toEqual({ autoOpened: false });
  });
});
