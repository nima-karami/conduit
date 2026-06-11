import { describe, expect, it } from 'vitest';
import { type ElementLike, isPanelDragTarget } from '../../webview/drag-guard';

// A minimal fake element tree implementing the `ElementLike` surface the guard reads.
// Each node carries a tag + class list + attributes and a parent link, so `closest`
// (self-then-ancestors selector match) and `contains` (descendant check) behave like
// the DOM for the simple selectors the guard uses.
class FakeEl implements ElementLike {
  parent: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  constructor(
    readonly tag: string,
    readonly classes: string[] = [],
    readonly attrs: Record<string, string> = {},
  ) {}

  add(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  private matches(sel: string): boolean {
    const s = sel.trim();
    if (s.startsWith('.')) return this.classes.includes(s.slice(1));
    if (s.startsWith('[')) {
      // [attr] or [attr="val"]
      const m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(s);
      if (!m) return false;
      const [, name, val] = m;
      return val === undefined ? name in this.attrs : this.attrs[name] === val;
    }
    return this.tag === s;
  }

  closest(selectors: string): ElementLike | null {
    const sels = selectors.split(',').map((x) => x.trim());
    let node: FakeEl | null = this;
    while (node) {
      if (sels.some((sel) => node?.matches(sel))) return node;
      node = node.parent;
    }
    return null;
  }

  contains(other: unknown): boolean {
    let node = other as FakeEl | null;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
}

describe('isPanelDragTarget', () => {
  it('true when the target is the bar background itself', () => {
    const bar = new FakeEl('div', ['panel__bar']);
    expect(isPanelDragTarget(bar, bar)).toBe(true);
  });

  it('true for a plain non-interactive descendant', () => {
    const bar = new FakeEl('div', ['panel__bar']);
    const filler = bar.add(new FakeEl('span', ['filler']));
    expect(isPanelDragTarget(filler, bar)).toBe(true);
  });

  it('false when target is a button, even nested deep', () => {
    const bar = new FakeEl('div', ['panel__bar']);
    const btn = bar.add(new FakeEl('button'));
    const svg = btn.add(new FakeEl('svg'));
    const path = svg.add(new FakeEl('path'));
    expect(isPanelDragTarget(path, bar)).toBe(false);
  });

  it('false for an input (filter field)', () => {
    const bar = new FakeEl('div', ['sessbar']);
    const input = bar.add(new FakeEl('input', ['sessbar__filter']));
    expect(isPanelDragTarget(input, bar)).toBe(false);
  });

  it('false for an own-draggable tab child', () => {
    const bar = new FakeEl('div', ['tabbar']);
    const tab = bar.add(new FakeEl('button', ['tab'], { draggable: 'true' }));
    const label = tab.add(new FakeEl('span'));
    expect(isPanelDragTarget(label, bar)).toBe(false);
  });

  it('false for a session card by class even when not currently draggable', () => {
    const bar = new FakeEl('div', ['sidebar']);
    const card = bar.add(new FakeEl('div', ['session'])); // no draggable attr
    const body = card.add(new FakeEl('span', ['session__body']));
    expect(isPanelDragTarget(body, bar)).toBe(false);
  });

  it('false for the inline rename input', () => {
    const bar = new FakeEl('div', ['sidebar']);
    const card = bar.add(new FakeEl('div', ['session']));
    const input = card.add(new FakeEl('input', ['session__edit']));
    expect(isPanelDragTarget(input, bar)).toBe(false);
  });

  it('false for a [role="button"] element', () => {
    const bar = new FakeEl('div', ['panel__bar']);
    const rb = bar.add(new FakeEl('div', [], { role: 'button' }));
    expect(isPanelDragTarget(rb, bar)).toBe(false);
  });

  it('true when the bar itself is draggable (drag source) and target is the bar', () => {
    // The real bar carries draggable="true"; a match on the bar itself must NOT
    // disqualify a drag from its own background.
    const bar = new FakeEl('div', ['tabbar'], { draggable: 'true' });
    expect(isPanelDragTarget(bar, bar)).toBe(true);
  });

  it('true for a plain descendant when the only draggable ancestor is the bar', () => {
    const bar = new FakeEl('div', ['tabbar'], { draggable: 'true' });
    const filler = bar.add(new FakeEl('span', ['filler']));
    expect(isPanelDragTarget(filler, bar)).toBe(true);
  });

  it('false for a draggable child even when the bar is also draggable', () => {
    const bar = new FakeEl('div', ['tabbar'], { draggable: 'true' });
    const tab = bar.add(new FakeEl('button', ['tab'], { draggable: 'true' }));
    expect(isPanelDragTarget(tab, bar)).toBe(false);
  });

  // Lock down every member of INTERACTIVE_SELECTOR, not just the few hit above.
  it.each([
    ['button', new FakeEl('button')],
    ['anchor', new FakeEl('a')],
    ['input', new FakeEl('input')],
    ['select', new FakeEl('select')],
    ['textarea', new FakeEl('textarea')],
    ['label', new FakeEl('label')],
    ['role=button', new FakeEl('div', [], { role: 'button' })],
    ['role=menuitem', new FakeEl('div', [], { role: 'menuitem' })],
    ['draggable', new FakeEl('div', [], { draggable: 'true' })],
    ['contenteditable', new FakeEl('div', [], { contenteditable: 'true' })],
    ['.tab', new FakeEl('div', ['tab'])],
    ['.session', new FakeEl('div', ['session'])],
  ])('false for an in-bar %s control', (_name, control) => {
    const bar = new FakeEl('div', ['panel__bar']);
    bar.add(control);
    const child = control.add(new FakeEl('span'));
    expect(isPanelDragTarget(control, bar)).toBe(false);
    expect(isPanelDragTarget(child, bar)).toBe(false);
  });

  it('false when target is null or outside the bar', () => {
    const bar = new FakeEl('div', ['panel__bar']);
    const outside = new FakeEl('div', ['elsewhere']);
    expect(isPanelDragTarget(null, bar)).toBe(false);
    expect(isPanelDragTarget(outside, bar)).toBe(false);
  });
});
