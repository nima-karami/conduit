import { beforeEach, describe, expect, it } from 'vitest';
import { tabStateKey } from '../../webview/editor-group-context';
import {
  cancelDocFocus,
  type FocusTarget,
  registerFocusTarget,
  requestDocFocus,
  terminalFocusKey,
} from '../../webview/focus-targets';

function target(): FocusTarget & { focused: number } {
  const t = {
    focused: 0,
    focus: () => {
      t.focused += 1;
    },
  };
  return t;
}

let teardowns: (() => void)[] = [];
beforeEach(() => {
  cancelDocFocus();
  for (const t of teardowns) t();
  teardowns = [];
});
const reg = (key: string, t: FocusTarget) => {
  const off = registerFocusTarget(key, t);
  teardowns.push(off);
  return off;
};

const doc2 = tabStateKey('file:/w/a.ts', 2);
const doc1 = tabStateKey('file:/w/a.ts', 1);

describe('focus-targets — per-(doc, group) focus requests', () => {
  it('a request for (doc, 2) is not consumed by (doc, 1) or by an unrelated doc; (doc, 2) takes it', () => {
    requestDocFocus(doc2);
    const sameDocOtherGroup = target();
    reg(doc1, sameDocOtherGroup);
    const unrelated = target();
    reg(tabStateKey('file:/w/b.ts', 2), unrelated);
    expect(sameDocOtherGroup.focused).toBe(0);
    expect(unrelated.focused).toBe(0);

    const right = target();
    reg(doc2, right);
    expect(right.focused).toBe(1);
  });

  it('a consumed request focuses only once', () => {
    requestDocFocus(doc2);
    reg(doc2, target());
    const again = target();
    reg(doc2, again);
    expect(again.focused).toBe(0);
  });

  it('cancelDocFocus clears a pending request', () => {
    requestDocFocus(doc2);
    cancelDocFocus();
    const t = target();
    reg(doc2, t);
    expect(t.focused).toBe(0);
  });

  it('a newer request supersedes the pending one', () => {
    requestDocFocus(doc2);
    requestDocFocus(doc1);
    const old = target();
    reg(doc2, old);
    expect(old.focused).toBe(0);
    const current = target();
    reg(doc1, current);
    expect(current.focused).toBe(1);
  });

  it('a mounted target is focused at once and leaves nothing pending', () => {
    const t = target();
    reg(doc1, t);
    requestDocFocus(doc1);
    expect(t.focused).toBe(1);
    const later = target();
    reg(doc1, later);
    expect(later.focused).toBe(0);
  });

  it('a request for a mounted target supersedes an older pending one', () => {
    requestDocFocus(doc2);
    const mounted = target();
    reg(doc1, mounted);
    requestDocFocus(doc1);
    const stale = target();
    reg(doc2, stale);
    expect(mounted.focused).toBe(1);
    expect(stale.focused).toBe(0);
  });

  it('the newest registration of a key is the one focused, and a stale teardown keeps it', () => {
    const first = target();
    const offFirst = reg(doc1, first);
    const second = target();
    reg(doc1, second);
    offFirst();
    requestDocFocus(doc1);
    expect(second.focused).toBe(1);
    expect(first.focused).toBe(0);
  });

  it("the Terminal's key is per session", () => {
    requestDocFocus(terminalFocusKey('S1'));
    const other = target();
    reg(terminalFocusKey('S2'), other);
    const own = target();
    reg(terminalFocusKey('S1'), own);
    expect(other.focused).toBe(0);
    expect(own.focused).toBe(1);
  });
});
