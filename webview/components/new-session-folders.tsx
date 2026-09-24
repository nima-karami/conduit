import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { folderKey } from '../../src/folder-key';
import type { Rect } from '../../src/menu-position';
import type { RepoDTO } from '../../src/protocol';
import { sessionNameFromPath } from '../../src/session-name';
import { requestHost } from '../host-request';
import { IconFolder, IconPlus } from '../icons';
import { type FolderProbe, MAX_DIALOG_FOLDERS } from '../new-session-state';
import { moveMenuFocus } from './new-session-launch-row';
import { Popover } from './popover';

const MAX_RECENT = 10;
/** A native dialog can sit open for as long as the user likes. */
const PICK_TIMEOUT_MS = 120_000;

export interface NewSessionFoldersProps {
  folders: string[];
  probes: Record<string, FolderProbe>;
  repos: RepoDTO[];
  flashKey?: string;
  hint?: string;
  atCap: boolean;
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
  onMakeHome: (path: string) => void;
}

type PendingFocus = { kind: 'added'; key: string } | { kind: 'removed'; index: number };

export function NewSessionFolders({
  folders,
  probes,
  repos,
  flashKey,
  hint,
  atCap,
  onAdd,
  onRemove,
  onMakeHome,
}: NewSessionFoldersProps) {
  const [menu, setMenu] = useState<Rect | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const keys = folders.map(folderKey);

  // Spec §10 "Focus": after an add, that row's first button; after ×, the next row or Add.
  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('.ns-folder') ?? [])];
    if (p.kind === 'added') {
      // A refused add (overlap hint) leaves nothing new to focus.
      rows[keys.indexOf(p.key)]?.querySelector<HTMLElement>('button')?.focus();
      return;
    }
    (rows[p.index]?.querySelector<HTMLElement>('button') ?? addRef.current)?.focus();
  });

  const add = (path: string) => {
    pendingFocus.current = { kind: 'added', key: folderKey(path) };
    onAdd(path);
  };

  const toggle = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    const el = addRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenu({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  };
  const close = () => {
    setMenu(null);
    addRef.current?.focus();
  };

  const recent = repos.filter((r) => !keys.includes(folderKey(r.path))).slice(0, MAX_RECENT);

  return (
    <div className="ns-folders-frame">
      {folders.length > 0 && (
        <ul ref={listRef} className="ns-folders" role="list">
          {folders.map((f, i) => {
            const key = keys[i];
            const probe = probes[key];
            const name = sessionNameFromPath(f);
            const home = i === 0;
            const missing = probe?.exists === false;
            const branch = probe?.exists ? probe.branch : undefined;
            return (
              <li
                key={key}
                role="listitem"
                className={`ns-folder${home ? ' ns-folder--home' : ''}${
                  key === flashKey ? ' ns-folder--flash' : ''
                }`}
                data-folder={f}
                data-exists={probe === undefined ? undefined : String(probe.exists)}
              >
                <span className="ns-folder__dot" aria-hidden />
                <span className="ns-folder__text">
                  <span className="ns-folder__name">{name}</span>
                  <span className="ns-folder__meta">
                    {/* Left-truncated like .repo__path; the LRM bookends keep a leading
                        `C:\` on its own side under the rtl direction. */}
                    <span className="ns-folder__path repo__path" title={f}>
                      {`\u200e${f}\u200e`}
                    </span>
                    {branch && <span className="ns-folder__branch">{` · ${branch}`}</span>}
                  </span>
                </span>
                {missing && <span className="ns-folder__missing">Not found</span>}
                {home && <span className="ns-folder__home">Home</span>}
                {!home && !missing && (
                  <button
                    type="button"
                    className="ns-folder__make"
                    aria-label={`Make ${name} home`}
                    onClick={() => onMakeHome(f)}
                  >
                    Make home
                  </button>
                )}
                {(!home || folders.length === 1) && (
                  <button
                    type="button"
                    className="ns-folder__remove"
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name}`}
                    onClick={() => {
                      pendingFocus.current = { kind: 'removed', index: i };
                      onRemove(f);
                    }}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* Outside the scrolling list, so it never scrolls away (what new-session-browse-pinned
          guarded for the old dialog's Browse row). */}
      <button
        ref={addRef}
        type="button"
        className={`ns-folders__add${folders.length === 0 ? ' ns-folders__add--only' : ''}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        disabled={atCap}
        onClick={toggle}
      >
        {atCap ? (
          `Folder limit reached (${MAX_DIALOG_FOLDERS})`
        ) : (
          <>
            <IconPlus size={13} className="ns-folders__plus" aria-hidden />
            Add folder…
          </>
        )}
      </button>
      {hint && (
        <div className="ns-folders__hint" role="status">
          {hint}
        </div>
      )}
      {menu && (
        <AddFolderMenu
          anchor={menu}
          triggerRef={addRef}
          recent={recent}
          onClose={close}
          onPick={(path) => {
            setMenu(null);
            add(path);
          }}
          onBrowse={async () => {
            setMenu(null);
            const reply = await requestHost(
              (requestId) => ({ type: 'folder:pick', requestId }),
              ['folder:picked'],
              PICK_TIMEOUT_MS,
            );
            if (reply?.path) add(reply.path);
            else addRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function AddFolderMenu({
  anchor,
  triggerRef,
  recent,
  onClose,
  onPick,
  onBrowse,
}: {
  anchor: Rect;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  recent: RepoDTO[];
  onClose: () => void;
  onPick: (path: string) => void;
  onBrowse: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  return (
    <Popover
      ref={ref}
      anchor={anchor}
      align="start"
      width={anchor.right - anchor.left}
      role="menu"
      aria-label="Add folder"
      className="ctxmenu ns-addmenu"
      triggerRef={triggerRef}
      onClose={onClose}
      onKeyDown={moveMenuFocus}
    >
      <div role="group" aria-label="Recent">
        <div className="ns-addmenu__head" aria-hidden>
          Recent
        </div>
        {recent.length === 0 ? (
          <div className="ns-addmenu__empty">No recent folders</div>
        ) : (
          recent.map((r) => (
            <button
              key={r.path}
              type="button"
              role="menuitem"
              className="ctxmenu__item ns-addmenu__item"
              title={r.path}
              onClick={() => onPick(r.path)}
            >
              <span className="ns-addmenu__name">{r.name}</span>
              <span className="repo__path">{`\u200e${r.path}\u200e`}</span>
            </button>
          ))
        )}
      </div>
      <div className="ctxmenu__sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="ctxmenu__item ns-addmenu__browse"
        onClick={onBrowse}
      >
        <span className="ctxmenu__icon">
          <IconFolder size={13} />
        </span>
        Browse…
      </button>
    </Popover>
  );
}
