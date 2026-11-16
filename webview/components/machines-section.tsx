import { Fragment, useMemo, useRef, useState } from 'react';
import type { MachineError, MachineView } from '../../src/contracts/machines';
import { triggerMenu } from '../../src/menu-position';
import { IconChevron, IconMore, IconPlus } from '../icons';
import { MACHINES_STR } from '../machines-strings';
import type { RemoteKey, RemoteSessionRow as Row } from '../remote-sessions';
import type { ConfirmState } from './confirm-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { RemoteSessionRow } from './remote-session-row';
import { RenameInput } from './session-card';

export type MachineAction = 'connect' | 'retry' | 'disconnect' | 'rename' | 'remove' | 'copyFix';

/** What the status mark shows: each tone has its own shape in CSS, so colour is never the only cue. */
type Tone = 'up' | 'needs' | 'failed' | 'offline' | 'pending';

/** Error codes that mean the machine cannot be used until the owner changes something. */
const FAILED_CODES: ReadonlySet<string> = new Set([
  'identity_changed',
  'identity_conflict',
  'peer_incompatible',
  'remote_unsupported',
  'install_failed',
]);

function toneOf(m: MachineView, err: MachineError | undefined): Tone {
  if (err?.code === 'ssh_needs_person') return 'needs';
  if (err && FAILED_CODES.has(err.code)) return 'failed';
  switch (m.state) {
    case 'up':
      return 'up';
    case 'incompatible':
    case 'identity-changed':
    case 'revoked':
      return 'failed';
    case 'down':
    case 'disabled':
      return 'offline';
    default:
      return 'pending';
  }
}

function statusOf(m: MachineView, err: MachineError | undefined): string {
  if (err?.code === 'ssh_needs_person')
    return MACHINES_STR.needsYou(m.machine, err.detail.reason ?? '');
  if (m.state === 'down') return MACHINES_STR.offlineSince(m.last_seen);
  return MACHINES_STR.state(m.state);
}

/** The inline actions a row offers for its state (spec §9.1; Remove asks first, see askRemove). */
function inlineActions(
  m: MachineView,
  err: MachineError | undefined,
): { action: MachineAction; label: string }[] {
  if (err?.code === 'ssh_needs_person') return [{ action: 'connect', label: MACHINES_STR.connect }];
  if (m.state === 'down') return [{ action: 'retry', label: MACHINES_STR.retryNow }];
  if (m.state === 'disabled') return [{ action: 'connect', label: MACHINES_STR.connect }];
  if (m.state === 'incompatible' || m.state === 'identity-changed')
    return [
      { action: 'copyFix', label: MACHINES_STR.copyFix },
      { action: 'remove', label: MACHINES_STR.remove },
    ];
  return [];
}

/** Keys of the rows the tree shows, in order: a machine, then its sessions when it is open. */
const machineKey = (id: string) => `machine:${id}`;

/**
 * The Machines band (spec §9.1, §9.2; plan decision 9): its own treeitem tree below the Agents
 * tree. Rows are machines (level 1) with their remote sessions under them (level 2).
 */
export function MachinesSection({
  machines,
  remoteRows,
  machineErrors,
  activeRemoteId,
  onSelectRemote,
  onAddMachine,
  onMachineAction,
  onRenameMachine,
  onConfirm,
}: {
  machines: readonly MachineView[];
  remoteRows: readonly Row[];
  /** The last error per machine name, from the owner's own connect attempts. */
  machineErrors: ReadonlyMap<string, MachineError>;
  activeRemoteId: string | null;
  onSelectRemote: (key: RemoteKey) => void;
  onAddMachine: () => void;
  onMachineAction: (action: MachineAction, machine: MachineView) => void;
  onRenameMachine: (machine: MachineView, name: string) => void;
  onConfirm: (c: ConfirmState) => void;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  // Folded machines; a machine opens by default, so only the folded ones are remembered.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const sessionsOf = useMemo(() => {
    const byMachine = new Map<string, Row[]>();
    for (const r of remoteRows) {
      const list = byMachine.get(r.key.machineId) ?? [];
      list.push(r);
      byMachine.set(r.key.machineId, list);
    }
    return byMachine;
  }, [remoteRows]);
  const remoteById = useMemo(() => new Map(remoteRows.map((r) => [r.id, r])), [remoteRows]);

  const isOpen = (m: MachineView) => !folded.has(m.machine_id);
  const toggle = (m: MachineView) =>
    setFolded((cur) => {
      const next = new Set(cur);
      if (next.has(m.machine_id)) next.delete(m.machine_id);
      else next.add(m.machine_id);
      return next;
    });

  // Rows as the tree shows them, so the roving tab stop and the arrow keys agree with the DOM.
  const visibleKeys = machines.flatMap((m) => [
    machineKey(m.machine_id),
    ...(isOpen(m) ? (sessionsOf.get(m.machine_id) ?? []).map((r) => r.id) : []),
  ]);
  const tabKey = focusKey !== null && visibleKeys.includes(focusKey) ? focusKey : visibleKeys[0];

  const items = (): HTMLElement[] => [
    ...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
  ];

  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute('role') !== 'treeitem') return;
    const all = items();
    const at = all.indexOf(el);
    const go = (target: HTMLElement | undefined) => {
      e.preventDefault();
      target?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        return go(all[at + 1]);
      case 'ArrowUp':
        return go(at > 0 ? all[at - 1] : undefined);
      case 'Home':
        return go(all[0]);
      case 'End':
        return go(all[all.length - 1]);
    }
    const machineId = el.dataset.machineId;
    if (machineId !== undefined) {
      const m = machines.find((x) => x.machine_id === machineId);
      if (!m) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!isOpen(m)) toggle(m);
        else if (all[at + 1]?.dataset.remoteId !== undefined) all[at + 1].focus();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (isOpen(m)) toggle(m);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        toggle(m);
      }
      return;
    }
    const remoteId = el.dataset.remoteId;
    if (remoteId === undefined) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      for (let i = at - 1; i >= 0; i--) {
        if (all[i].dataset.machineId !== undefined) {
          all[i].focus();
          return;
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = remoteById.get(remoteId);
      if (r) onSelectRemote(r.key);
    }
  };

  const askRemove = (m: MachineView) =>
    onConfirm({
      title: MACHINES_STR.removeTitle(m.machine),
      message: MACHINES_STR.removeBody,
      confirmLabel: MACHINES_STR.remove,
      danger: true,
      focusCancel: true,
      onConfirm: () => onMachineAction('remove', m),
    });

  const menuItems = (m: MachineView): MenuItem[] => [
    {
      label: MACHINES_STR.disconnect,
      disabled: m.state === 'disabled' || m.state === 'revoked',
      onClick: () => onMachineAction('disconnect', m),
    },
    { label: MACHINES_STR.rename, onClick: () => setRenamingId(m.machine_id) },
    {
      label: MACHINES_STR.remove,
      danger: true,
      separatorBefore: true,
      onClick: () => askRemove(m),
    },
  ];

  const runAction = (
    e: React.MouseEvent<HTMLButtonElement>,
    action: MachineAction,
    m: MachineView,
  ) => {
    if (action === 'remove') askRemove(m);
    else onMachineAction(action, m);
    // Retry keeps the focus on its row, so a keyboard user does not lose their place (§9.3).
    e.currentTarget.closest<HTMLElement>('[role="treeitem"]')?.focus();
  };

  if (machines.length === 0)
    return (
      <>
        <div className="panel-head">
          <span className="panel-title">{MACHINES_STR.machines}</span>
        </div>
        <EmptyState
          variant="panel"
          title={MACHINES_STR.emptyTitle}
          hint={MACHINES_STR.emptyHint}
          action={
            <button type="button" className="btn btn--primary" onClick={onAddMachine}>
              {MACHINES_STR.addMachine}
            </button>
          }
        />
      </>
    );

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">{MACHINES_STR.machines}</span>
        <div className="panel-head__actions">
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title={MACHINES_STR.addMachine}
            aria-label={MACHINES_STR.addMachine}
            onClick={onAddMachine}
          >
            <IconPlus size={15} />
          </button>
        </div>
      </div>
      <div
        ref={treeRef}
        className="machines"
        role="tree"
        aria-label={MACHINES_STR.machines}
        onKeyDown={onTreeKey}
      >
        {machines.map((m) => {
          const err = machineErrors.get(m.machine);
          const open = isOpen(m);
          const key = machineKey(m.machine_id);
          const tone = toneOf(m, err);
          const status = statusOf(m, err);
          const sessions = sessionsOf.get(m.machine_id) ?? [];
          const meta = [MACHINES_STR.os(m.os), MACHINES_STR.mode(m.mode)].filter(Boolean);
          const note = err && err.code !== 'ssh_needs_person' ? MACHINES_STR.error(err.code) : null;
          return (
            <Fragment key={key}>
              <div
                className="machine-row"
                role="treeitem"
                aria-level={1}
                aria-expanded={open}
                aria-label={MACHINES_STR.rowLabel({
                  name: m.machine,
                  status,
                  sessions: m.sessions,
                })}
                data-machine-id={m.machine_id}
                tabIndex={key === tabKey ? 0 : -1}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusKey(key);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: menuItems(m) });
                }}
              >
                {renamingId === m.machine_id ? (
                  <span className="machine-row__main">
                    <IconChevron
                      size={9}
                      className={`session__chev${open ? ' session__chev--open' : ''}`}
                    />
                    <RenameInput
                      name={m.machine}
                      label={MACHINES_STR.renameLabel}
                      onEnd={(draft) => {
                        setRenamingId(null);
                        const next = draft?.trim();
                        if (next && next !== m.machine) onRenameMachine(m, next);
                      }}
                    />
                  </span>
                ) : (
                  <button
                    type="button"
                    className="machine-row__main"
                    tabIndex={-1}
                    onClick={() => toggle(m)}
                  >
                    <IconChevron
                      size={9}
                      className={`session__chev${open ? ' session__chev--open' : ''}`}
                    />
                    <span className="machine-row__name">{m.machine}</span>
                  </button>
                )}
                <span className="machine-row__detail">
                  <span className="machine-row-status" data-tone={tone}>
                    {status}
                  </span>
                  {meta.length > 0 && <span className="machine-row__meta">{meta.join(' · ')}</span>}
                  <span className="machine-row__meta">{MACHINES_STR.sessions(m.sessions)}</span>
                  {note && <span className="machine-row__note">{note}</span>}
                </span>
                <span className="machine-row__acts">
                  {inlineActions(m, err).map((a) => (
                    <button
                      key={a.action}
                      type="button"
                      className="btn btn--sm"
                      tabIndex={-1}
                      onClick={(e) => runAction(e, a.action, m)}
                    >
                      {a.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="iconbtn iconbtn--sm"
                    tabIndex={-1}
                    title={MACHINES_STR.rowMenu(m.machine)}
                    aria-label={MACHINES_STR.rowMenu(m.machine)}
                    onClick={(e) =>
                      setMenu({
                        ...triggerMenu(e.currentTarget.getBoundingClientRect()),
                        keyboard: true,
                        items: menuItems(m),
                      })
                    }
                  >
                    <IconMore size={14} />
                  </button>
                </span>
              </div>
              {open &&
                sessions.map((r, i) => (
                  <RemoteSessionRow
                    key={r.id}
                    row={r}
                    depth={1}
                    level={2}
                    guides={[]}
                    lastChild={i === sessions.length - 1}
                    selected={activeRemoteId === r.id}
                    tabbable={r.id === tabKey}
                    onSelect={() => onSelectRemote(r.key)}
                    onFocus={() => setFocusKey(r.id)}
                  />
                ))}
            </Fragment>
          );
        })}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
