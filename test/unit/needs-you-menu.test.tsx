// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NeedsYouMenu, type NeedsYouMenuProps } from '../../webview/components/needs-you-menu';
import { type filterOptions, NO_FILTERS } from '../../webview/request-view-model';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const OPTIONS: ReturnType<typeof filterOptions> = {
  sessions: [
    { id: 's1', label: 'Three-process lead' },
    { id: 's2', label: 'app lane' },
  ],
  leads: [{ id: 's1', label: 'Three-process lead' }],
  spaces: [{ id: 'sp1', label: 'Conduit' }],
  types: ['approve', 'answer'],
  machines: ['studio-pc'],
};

const props = (over: Partial<NeedsYouMenuProps> = {}): NeedsYouMenuProps => ({
  sort: 'soonest',
  onSort: vi.fn(),
  filters: NO_FILTERS,
  onFilters: vi.fn(),
  options: OPTIONS,
  show: { space: false, age: false, machine: false },
  onShow: vi.fn(),
  onLegend: vi.fn(),
  ...over,
});

let host: HTMLDivElement;
let root: Root;

function mount(p: NeedsYouMenuProps) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<NeedsYouMenu {...p} />));
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error('expected an element');
  return v;
}

const trigger = () => must(host.querySelector<HTMLButtonElement>('button.needs-menu__trigger'));
const menus = () => Array.from(host.querySelectorAll<HTMLElement>('[role="menu"]'));
/** The items of one menu level: a submenu's items belong to it, not to the menu around it. */
const itemsOf = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
    (el) => el.closest('[role="menu"]') === menu,
  );
const itemNamed = (role: string, name: string) =>
  must(
    Array.from(host.querySelectorAll<HTMLElement>(`[role="${role}"]`)).find((el) =>
      (el.textContent ?? '').trim().startsWith(name),
    ),
  );
const press = (el: Element, key: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
const click = (el: Element) => act(() => (el as HTMLElement).click());
const open = () => click(trigger());
const active = () => must(document.activeElement as HTMLElement | null);

describe('NeedsYouMenu', () => {
  it('opens from the trigger and closes on Esc, returning focus', () => {
    mount(props());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(menus()).toHaveLength(1);
    expect(active().textContent).toContain('Soonest needed');

    press(active(), 'Escape');
    expect(menus()).toHaveLength(0);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('arrow keys move through items and wrap', () => {
    mount(props());
    open();
    const top = menus()[0] as HTMLElement;
    const items = itemsOf(top);
    expect(items).toHaveLength(13);

    press(active(), 'ArrowDown');
    expect(active()).toBe(items[1]);
    press(active(), 'ArrowUp');
    press(active(), 'ArrowUp');
    expect(active()).toBe(items[items.length - 1]);
    press(active(), 'ArrowDown');
    expect(active()).toBe(items[0]);
    press(active(), 'End');
    expect(active()).toBe(items[items.length - 1]);
    press(active(), 'Home');
    expect(active()).toBe(items[0]);
  });

  it('choosing a sort calls onSort', () => {
    const p = props();
    mount(p);
    open();
    click(itemNamed('menuitemradio', 'Newest'));
    expect(p.onSort).toHaveBeenCalledWith('newest');
  });

  it('right arrow opens a filter submenu; toggling a value calls onFilters with that dimension', () => {
    const p = props();
    mount(p);
    open();
    press(itemNamed('menuitem', 'Machine'), 'ArrowRight');

    expect(menus()).toHaveLength(2);
    const sub = menus()[1] as HTMLElement;
    expect(active()).toBe(itemsOf(sub)[0]);
    expect(itemsOf(sub).every((el) => el.getAttribute('role') === 'menuitemcheckbox')).toBe(true);

    press(active(), 'Enter');
    expect(p.onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, machines: ['studio-pc'] });
  });

  it('left arrow returns from a submenu', () => {
    mount(props());
    open();
    press(itemNamed('menuitem', 'Machine'), 'ArrowRight');
    expect(menus()).toHaveLength(2);

    press(active(), 'ArrowLeft');
    expect(menus()).toHaveLength(1);
    expect(active()).toBe(itemNamed('menuitem', 'Machine'));
  });

  it('Escape in a submenu returns to its row and keeps the menu open', () => {
    mount(props());
    open();
    press(itemNamed('menuitem', 'Type'), 'ArrowRight');
    press(active(), 'Escape');

    expect(menus()).toHaveLength(1);
    expect(active()).toBe(itemNamed('menuitem', 'Type'));
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('show toggles call onShow', () => {
    const p = props();
    mount(p);
    open();
    click(itemNamed('menuitemcheckbox', 'Age'));
    expect(p.onShow).toHaveBeenCalledWith({ space: false, age: true, machine: false });
  });

  it('What the icons mean calls onLegend and closes', () => {
    const p = props();
    mount(p);
    open();
    click(itemNamed('menuitem', 'What the icons mean'));
    expect(p.onLegend).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
  });

  it('lead group and space filters are present', () => {
    const p = props();
    mount(p);
    open();

    press(itemNamed('menuitem', 'Lead group'), 'ArrowRight');
    expect(itemNamed('menuitemcheckbox', 'Three-process lead')).toBeTruthy();
    press(active(), 'ArrowLeft');

    press(itemNamed('menuitem', 'Space'), 'ArrowRight');
    click(itemNamed('menuitemcheckbox', 'Conduit'));
    expect(p.onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, spaces: ['sp1'] });
  });

  it('a press outside closes the menu', () => {
    mount(props());
    open();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menus()).toHaveLength(0);
  });
});
