import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Rect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { AgentKind } from '../../src/sidebar-view';
import { IconCheck, IconMore, SessionGlyph } from '../icons';
import { moveMenuFocus } from '../menu-focus';
import { SIDEBAR_STR } from '../sidebar-strings';
import type { ViewMenuModel, ViewMenuOption, ViewMenuSection } from '../sidebar-view-menu';
import { Popover } from './popover';

const FIRST_CHOICE = '[role="menuitemradio"], [role="menuitemcheckbox"]';

/** The ⋯ button of a panel header and the menu it opens (sort / group / filter), in the context
 *  menu's own surface and row styling. Picks apply at once and the menu stays open. */
export function ViewMenu({ label, model }: { label: string; model: ViewMenuModel }) {
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const everOpenRef = useRef(false);
  // Read while the menu is still mounted: after it unmounts focus is already on <body>.
  const returnFocusRef = useRef(false);
  const open = anchor !== null;
  const customized = model.reset !== null;
  const hasChips = model.sections.some((s) => s.chips);

  useEffect(() => {
    if (open) {
      everOpenRef.current = true;
      menuRef.current?.querySelector<HTMLElement>(FIRST_CHOICE)?.focus();
      return;
    }
    if (everOpenRef.current && returnFocusRef.current) triggerRef.current?.focus();
    everOpenRef.current = false;
  }, [open]);

  const dismiss = useCallback(() => {
    returnFocusRef.current = !!menuRef.current?.contains(document.activeElement);
    setAnchor(null);
  }, []);

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // A keyboard click never saw the mousedown that records the open state.
    const wasOpen = e.detail === 0 ? open : wasOpenRef.current;
    if (menuToggleIntent(wasOpen) === 'close') {
      dismiss();
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  };

  const reset = () => {
    model.reset?.();
    // The Reset button leaves with the customisation it clears; keep focus inside the menu.
    queueMicrotask(() => menuRef.current?.querySelector<HTMLElement>(FIRST_CHOICE)?.focus());
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="iconbtn iconbtn--sm viewmenu__trigger"
        title={label}
        aria-label={customized ? `${label}, ${SIDEBAR_STR.viewMenu.customized}` : label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={() => {
          wasOpenRef.current = open;
        }}
        onClick={onClick}
      >
        <IconMore size={15} />
        {customized && <span className="viewmenu__dot" aria-hidden />}
      </button>
      {anchor && (
        <Popover
          ref={menuRef}
          anchor={anchor}
          align="end"
          role="menu"
          aria-label={label}
          className={`ctxmenu viewmenu${hasChips ? ' viewmenu--chips' : ''}`}
          triggerRef={triggerRef}
          onClose={dismiss}
          onKeyDown={moveMenuFocus}
        >
          <div className="ctxmenu__scroll">
            {model.sections.map((section, i) => (
              <Section
                key={section.id}
                section={section}
                onReset={i === 0 && model.reset ? reset : null}
              />
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

function Section({ section, onReset }: { section: ViewMenuSection; onReset: (() => void) | null }) {
  const labelId = useId();
  return (
    <div className="viewmenu__section" role="group" aria-labelledby={labelId}>
      <div className="viewmenu__head">
        <span className="viewmenu__label" id={labelId}>
          {section.label}
        </span>
        {onReset && (
          <button type="button" role="menuitem" className="viewmenu__reset" onClick={onReset}>
            {SIDEBAR_STR.viewMenu.reset}
          </button>
        )}
      </div>
      {section.options.map((o) => (
        <Option key={o.id} option={o} kind={section.kind} />
      ))}
      {section.chips && (
        <div className="viewmenu__chips" role="group" aria-label={section.chips.label}>
          {section.chips.items.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={c.checked}
              className="viewmenu__chip"
              onClick={c.onSelect}
            >
              <KindGlyph kind={c.id} />
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Option({ option, kind }: { option: ViewMenuOption; kind: 'radio' | 'check' }) {
  return (
    <button
      type="button"
      role={kind === 'radio' ? 'menuitemradio' : 'menuitemcheckbox'}
      aria-checked={option.checked}
      className="ctxmenu__item viewmenu__option"
      onClick={option.onSelect}
    >
      <span className={`viewmenu__ind viewmenu__ind--${kind}`} aria-hidden>
        {kind === 'check' && option.checked && <IconCheck size={10} />}
      </span>
      <span className="ctxmenu__label">{option.label}</span>
      {option.hint !== undefined && <span className="ctxmenu__hint">{option.hint}</span>}
    </button>
  );
}

/** `other` has no mark of its own; the neutral robot stands for "any other agent". */
function KindGlyph({ kind }: { kind: AgentKind }) {
  return (
    <SessionGlyph icon={{ type: 'kind', kind: kind === 'other' ? 'agent' : kind }} size={14} />
  );
}
