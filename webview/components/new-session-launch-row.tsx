import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import {
  type LauncherDTO,
  type LauncherKind,
  type LaunchRanking,
  MAX_CUSTOM_LAUNCHERS,
} from '../../src/launchers';
import type { Rect } from '../../src/menu-position';
import type { AgentDefinition } from '../../src/types';
import { post } from '../bridge';
import { requestHost } from '../host-request';
import { IconChevronDown } from '../icons';
import { useOverlayEntry } from '../use-overlay-entry';
import { Popover } from './popover';

const TAG: Record<LauncherKind, string> = {
  cli: 'PATH',
  shell: 'shell',
  config: 'config',
  custom: 'custom',
};

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
};

/** Arrow/Home/End focus movement across a menu's enabled items; shared by the dialog's menus. */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    ),
  ];
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[at < 0 && e.key === 'ArrowUp' ? items.length - 1 : next]?.focus();
}

export interface NewSessionLaunchRowProps {
  agents: AgentDefinition[];
  launchers: LauncherDTO[];
  ranking: LaunchRanking;
  selectedId: string;
  extraPillId?: string;
  onPick: (id: string, fromMore: boolean) => void;
  customCount: number;
}

interface Pill {
  id: string;
  label: string;
}

export function NewSessionLaunchRow({
  agents,
  launchers,
  ranking,
  selectedId,
  extraPillId,
  onPick,
  customCount,
}: NewSessionLaunchRowProps) {
  const [menu, setMenu] = useState<Rect | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const labelOf = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  const kindOf = (id: string) => launchers.find((l) => l.id === id)?.kind;

  const pills: Pill[] = ranking.row.map((id) => ({ id, label: labelOf(id) }));
  if (ranking.shellId) pills.push({ id: ranking.shellId, label: 'Shell' });
  // A pick that isn't in the row stays visible as its own pill (spec §2.1 "Selected state").
  const shown = new Set(pills.map((p) => p.id));
  const extra = extraPillId && !shown.has(extraPillId) ? extraPillId : undefined;
  const stray = !shown.has(selectedId) && selectedId !== extra ? selectedId : undefined;
  for (const id of [extra, stray]) {
    if (id && agents.some((a) => a.id === id)) pills.push({ id, label: labelOf(id) });
  }
  const focusable = pills.some((p) => p.id === selectedId) ? selectedId : pills[0]?.id;

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined || pills.length === 0) return;
    e.preventDefault();
    const at = pills.findIndex((p) => p.id === selectedId);
    const next = pills[(Math.max(at, 0) + step + pills.length) % pills.length];
    onPick(next.id, false);
    requestAnimationFrame(() => {
      const pills = rowRef.current?.querySelectorAll<HTMLElement>('[data-launcher]') ?? [];
      [...pills].find((el) => el.dataset.launcher === next.id)?.focus();
    });
  };

  const closeMenu = () => setMenu(null);
  const atCap = customCount >= MAX_CUSTOM_LAUNCHERS;

  if (agents.length === 0) {
    return (
      <div className="ns-launch" role="radiogroup" aria-label="Launch">
        <span className="ns-launch__empty">No terminals found</span>
      </div>
    );
  }

  return (
    <>
      <div
        ref={rowRef}
        className="ns-launch"
        role="radiogroup"
        aria-label="Launch"
        onKeyDown={onRowKey}
      >
        {pills.map((p) => {
          const on = p.id === selectedId;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-launcher={p.id}
              tabIndex={p.id === focusable ? 0 : -1}
              className={`ns-pill${on ? ' ns-pill--on chamfer--sm' : ''}`}
              onClick={() => onPick(p.id, false)}
            >
              {p.label}
            </button>
          );
        })}
        <button
          ref={moreRef}
          type="button"
          className="ns-more"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => (menu ? closeMenu() : setMenu(rectOf(e.currentTarget)))}
        >
          More
          <IconChevronDown size={11} className="ns-more__caret" aria-hidden />
        </button>
      </div>
      {menu && (
        <MoreMenu
          anchor={menu}
          triggerRef={moreRef}
          ids={ranking.more}
          selectedId={selectedId}
          labelOf={labelOf}
          kindOf={kindOf}
          atCap={atCap}
          onClose={() => {
            closeMenu();
            moreRef.current?.focus();
          }}
          onPick={(id) => {
            closeMenu();
            onPick(id, true);
            moreRef.current?.focus();
          }}
          onCustom={() => {
            closeMenu();
            setFormOpen(true);
          }}
        />
      )}
      {formOpen && (
        <CustomCommandForm
          onDone={(id) => {
            setFormOpen(false);
            if (id) onPick(id, true);
            moreRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

function MoreMenu({
  anchor,
  triggerRef,
  ids,
  selectedId,
  labelOf,
  kindOf,
  atCap,
  onClose,
  onPick,
  onCustom,
}: {
  anchor: Rect;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  ids: string[];
  selectedId: string;
  labelOf: (id: string) => string;
  kindOf: (id: string) => LauncherKind | undefined;
  atCap: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
  onCustom: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, []);
  return (
    <Popover
      ref={ref}
      anchor={anchor}
      align="end"
      width={210}
      style={{ width: 210 }}
      role="menu"
      aria-label="More launchers"
      className="ctxmenu ns-more-menu"
      triggerRef={triggerRef}
      onClose={onClose}
      onKeyDown={moveMenuFocus}
    >
      <div role="group" aria-label="Found on this machine">
        <div className="ns-more__head" aria-hidden>
          Found on this machine
        </div>
        {ids.map((id) => {
          const kind = kindOf(id);
          const label = labelOf(id);
          return (
            <div key={id} className="ns-more__row">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={id === selectedId}
                className="ctxmenu__item ns-more__item"
                onClick={() => onPick(id)}
              >
                <span className="ns-more__label">{label}</span>
                {kind && <span className="ns-more__tag">{TAG[kind]}</span>}
              </button>
              {kind === 'custom' && (
                <button
                  type="button"
                  className="ns-more__remove"
                  aria-label={`Remove ${label}`}
                  title={`Remove ${label}`}
                  onClick={() => post({ type: 'launcher:removeCustom', id })}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        role="menuitem"
        className="ctxmenu__item ns-more__custom"
        disabled={atCap}
        onClick={onCustom}
      >
        {atCap ? `Custom launcher limit reached (${MAX_CUSTOM_LAUNCHERS})` : '+ Custom command…'}
      </button>
    </Popover>
  );
}

function CustomCommandForm({ onDone }: { onDone: (id?: string) => void }) {
  const [command, setCommand] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // An inner layer for Escape, so it cancels the form instead of closing the whole dialog.
  useOverlayEntry('popover', () => onDone());
  useEffect(() => inputRef.current?.focus(), []);

  const add = async () => {
    setBusy(true);
    setError(null);
    const reply = await requestHost(
      (requestId) => ({
        type: 'launcher:addCustom',
        requestId,
        commandLine: command,
        ...(label.trim() ? { label } : {}),
      }),
      ['launcher:added'],
      5000,
    );
    setBusy(false);
    if (reply?.id) onDone(reply.id);
    else setError(reply?.error ?? 'No reply from host');
  };

  return (
    <form
      className="ns-custom"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void add();
      }}
    >
      <input
        ref={inputRef}
        className="ns-input ns-custom__command"
        aria-label="Command"
        placeholder="e.g. aider --model sonnet"
        spellCheck={false}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      <input
        className="ns-input ns-custom__label"
        aria-label="Label"
        placeholder="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      {error && (
        <div className="ns-custom__error" role="alert">
          {error}
        </div>
      )}
      <div className="ns-custom__actions">
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          Add
        </button>
      </div>
    </form>
  );
}
