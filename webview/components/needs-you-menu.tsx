import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { REQ_STR } from '../request-strings';
import type { filterOptions, RequestFilters, ShowOnCards, SortKey } from '../request-view-model';

export interface NeedsYouMenuProps {
  sort: SortKey;
  onSort(k: SortKey): void;
  filters: RequestFilters;
  onFilters(f: RequestFilters): void;
  options: ReturnType<typeof filterOptions>;
  show: ShowOnCards;
  onShow(s: ShowOnCards): void;
  onLegend(): void;
}

const SORTS: readonly SortKey[] = ['soonest', 'newest', 'oldest', 'session'];
const ITEM_SELECTOR = '[role="menuitemradio"],[role="menuitemcheckbox"],[role="menuitem"]';

const itemsOf = (menu: HTMLElement | null): HTMLElement[] =>
  menu
    ? Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
        (el) => el.closest('[role="menu"]') === menu,
      )
    : [];

const toggled = <T,>(list: readonly T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

interface FilterRow {
  key: string;
  label: string;
  count: number;
  items: Array<{ value: string; label: string; checked: boolean; onToggle(): void }>;
}

export function NeedsYouMenu(p: NeedsYouMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  const { filters, onFilters, options } = p;
  const rowsFor = <T extends string>(
    key: string,
    label: string,
    opts: ReadonlyArray<{ value: T; label: string }>,
    selected: readonly T[],
    apply: (next: T[]) => RequestFilters,
  ): FilterRow => ({
    key,
    label,
    count: selected.length,
    items: opts.map((o) => ({
      value: o.value,
      label: o.label,
      checked: selected.includes(o.value),
      onToggle: () => onFilters(apply(toggled(selected, o.value))),
    })),
  });
  const rows: FilterRow[] = [
    rowsFor(
      'session',
      REQ_STR.filterSection.session,
      options.sessions.map((s) => ({ value: s.id, label: s.label })),
      filters.sessions,
      (next) => ({ ...filters, sessions: next }),
    ),
    rowsFor(
      'leads',
      REQ_STR.filterSection.leads,
      options.leads.map((s) => ({ value: s.id, label: s.label })),
      filters.leads,
      (next) => ({ ...filters, leads: next }),
    ),
    rowsFor(
      'space',
      REQ_STR.filterSection.space,
      options.spaces.map((s) => ({ value: s.id, label: s.label })),
      filters.spaces,
      (next) => ({ ...filters, spaces: next }),
    ),
    rowsFor(
      'type',
      REQ_STR.filterSection.type,
      options.types.map((t) => ({ value: t, label: REQ_STR.typeWord[t] })),
      filters.types,
      (next) => ({ ...filters, types: next }),
    ),
    rowsFor(
      'machine',
      REQ_STR.filterSection.machine,
      options.machines.map((m) => ({ value: m, label: m })),
      filters.machines,
      (next) => ({ ...filters, machines: next }),
    ),
  ];

  useLayoutEffect(() => {
    if (open) itemsOf(menuRef.current)[0]?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (sub !== null) itemsOf(subRef.current)[0]?.focus();
  }, [sub]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) {
        setOpen(false);
        setSub(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    setSub(null);
    triggerRef.current?.focus();
  };

  const backToRow = () => {
    const dim = sub;
    setSub(null);
    rootRef.current?.querySelector<HTMLElement>(`[role="menuitem"][data-dim="${dim}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLElement)) return;
    const menu = e.target.closest<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const items = itemsOf(menu);
    const at = items.indexOf(e.target);
    const inSub = menu === subRef.current;
    const handled = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    switch (e.key) {
      case 'ArrowDown':
        return handled(() => items[(at + 1) % items.length]?.focus());
      case 'ArrowUp':
        return handled(() => items[(at - 1 + items.length) % items.length]?.focus());
      case 'Home':
        return handled(() => items[0]?.focus());
      case 'End':
        return handled(() => items[items.length - 1]?.focus());
      case 'ArrowRight': {
        const dim = e.target.dataset.dim;
        if (!inSub && dim) handled(() => setSub(dim));
        return;
      }
      case 'ArrowLeft':
        if (inSub) handled(backToRow);
        return;
      case 'Escape':
        return handled(() => (inSub ? backToRow() : close()));
      case ' ':
      case 'Enter': {
        const dim = e.target.dataset.dim;
        if (e.target.getAttribute('aria-haspopup') === 'menu') {
          if (dim) handled(() => setSub(dim));
          return;
        }
        handled(() => e.target instanceof HTMLElement && e.target.click());
        return;
      }
      default:
        return;
    }
  };

  return (
    <div className="needs-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="needs-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={REQ_STR.needsMenu.trigger}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={REQ_STR.needsMenu.trigger}
          className="needs-menu__menu"
        >
          <div role="presentation" className="needs-menu__heading">
            {REQ_STR.needsMenu.sortHeading}
          </div>
          {SORTS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitemradio"
              aria-checked={p.sort === k}
              tabIndex={-1}
              className="needs-menu__item"
              onClick={() => p.onSort(k)}
            >
              <span className="needs-menu__mark" aria-hidden="true" />
              <span className="needs-menu__label">{REQ_STR.sort[k]}</span>
              {k === 'soonest' && (
                <span className="needs-menu__hint">{REQ_STR.needsMenu.defaultSort}</span>
              )}
            </button>
          ))}
          <div role="separator" className="needs-menu__sep" />
          <div role="presentation" className="needs-menu__heading">
            {REQ_STR.needsMenu.filterHeading}
          </div>
          {rows.map((row) => (
            <div key={row.key} role="none" className="needs-menu__row">
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={sub === row.key}
                data-dim={row.key}
                tabIndex={-1}
                className="needs-menu__item"
                onClick={() => setSub(row.key)}
              >
                <span className="needs-menu__label">{row.label}</span>
                <span className="needs-menu__value">
                  {row.count === 0 ? REQ_STR.needsMenu.all : row.count}
                  <span aria-hidden="true"> ›</span>
                </span>
              </button>
              {sub === row.key && (
                <div
                  ref={subRef}
                  role="menu"
                  aria-label={row.label}
                  className="needs-menu__menu needs-menu__menu--sub"
                >
                  {row.items.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={o.checked}
                      tabIndex={-1}
                      className="needs-menu__item"
                      onClick={o.onToggle}
                    >
                      <span className="needs-menu__mark" aria-hidden="true" />
                      <span className="needs-menu__label">{o.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div role="separator" className="needs-menu__sep" />
          <div role="presentation" className="needs-menu__heading">
            {REQ_STR.needsMenu.showHeading}
          </div>
          {(['space', 'age', 'machine'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="menuitemcheckbox"
              aria-checked={p.show[k]}
              tabIndex={-1}
              className="needs-menu__item"
              onClick={() => p.onShow({ ...p.show, [k]: !p.show[k] })}
            >
              <span className="needs-menu__mark" aria-hidden="true" />
              <span className="needs-menu__label">{REQ_STR.show[k]}</span>
            </button>
          ))}
          <div role="separator" className="needs-menu__sep" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="needs-menu__item"
            onClick={() => {
              close();
              p.onLegend();
            }}
          >
            <span className="needs-menu__label">{REQ_STR.legend}</span>
          </button>
        </div>
      )}
    </div>
  );
}
