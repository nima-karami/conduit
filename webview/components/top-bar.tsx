import { useEffect, useState } from 'react';
import { attentionChipLabel, attentionSessions } from '../../src/attention';
import type { Session } from '../../src/types';
import { win } from '../bridge';
import { CENTER_VIEWS, type CenterView } from '../center-view';
import {
  IconBoard,
  IconChevron,
  IconClose,
  IconDoc,
  IconGraph,
  IconSearch,
  IconSidebar,
  IconWinMax,
  IconWinMin,
  IconWinRestore,
} from '../icons';

const VIEW_ICON: Record<CenterView, JSX.Element> = {
  editor: <IconDoc size={14} />,
  board: <IconBoard size={14} />,
  canvas: <IconGraph size={14} />,
};

export function TopBar({
  isDev,
  onOpenSearch,
  onToggleSidebar,
  sidebarCollapsed,
  onBack,
  onForward,
  canBack,
  canForward,
  centerView,
  onSelectView,
  sessions,
  onFocusAttention,
  onContextMenu,
}: {
  isDev?: boolean;
  // Open the omni-search overlay (also bound to Mod+P). The center pill triggers it.
  onOpenSearch: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  centerView: CenterView;
  onSelectView: (view: CenterView) => void;
  /** Every session, for the aggregate attention chip's count. */
  sessions: Session[];
  /** Focus one session — the chip hands it the first one waiting on the user. */
  onFocusAttention: (sessionId: string) => void;
  // Right-click the top bar to open the panel show/hide menu.
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaxed);
    return win.onMaximizeChange(setMaxed);
  }, []);

  const waiting = attentionSessions(sessions);
  const chipLabel = attentionChipLabel(waiting.length);

  return (
    <header className="topbar" onContextMenu={onContextMenu}>
      <div className="topbar__left">
        <img
          src={isDev ? './icon-dev.png' : './icon.png'}
          alt={isDev ? 'Conduit (dev)' : 'Conduit'}
          title={isDev ? "Development build — isolated 'Conduit (dev)' profile" : undefined}
          className="topbar__logo"
        />
        {/* Labelled segmented control: Board and Canvas were unlabelled icons in a corner
            and nobody found them (brief §7.8), so the words are not optional. */}
        <div className="viewswitch" role="tablist" aria-label="Center view">
          {CENTER_VIEWS.map((v) => {
            const active = v.id === centerView;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`viewswitch__btn${active ? ' viewswitch__btn--on' : ''}`}
                title={v.label}
                onClick={() => onSelectView(v.id)}
              >
                {VIEW_ICON[v.id]}
                <span className="viewswitch__label">{v.short}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Center omni-search pill (R4.13): click or Mod+P opens the overlay across
          Sessions / Agents / Files (R5.4). */}
      <div className="topbar__center">
        <button
          type="button"
          className="omnibar"
          onClick={onOpenSearch}
          title="Search sessions, agents, files (Ctrl+P)"
          aria-label="Search sessions, agents, files"
          aria-keyshortcuts="Control+P"
        >
          <IconSearch size={14} className="omnibar__icon" />
          <span className="omnibar__placeholder">Search sessions, agents, files…</span>
        </button>
      </div>

      <div className="topbar__right">
        {/* Sidebar toggle + back/forward moved off the left so they don't crowd the
            switcher; the app mark and the switcher own the left edge (frame 5a). */}
        <div className="topbar__nav">
          <button
            className="iconbtn"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={onToggleSidebar}
          >
            <IconSidebar />
          </button>
          <button
            className="iconbtn iconbtn--rot"
            title="Back"
            disabled={!canBack}
            onClick={onBack}
          >
            <IconChevron />
          </button>
          <button className="iconbtn" title="Forward" disabled={!canForward} onClick={onForward}>
            <IconChevron />
          </button>
        </div>
        {chipLabel && (
          <button
            type="button"
            className="attnchip"
            title={`Go to ${waiting[0].name}`}
            onClick={() => onFocusAttention(waiting[0].id)}
          >
            <span className="attnchip__dot" aria-hidden />
            {chipLabel}
          </button>
        )}
        <div className="winctl">
          <button className="winctl__btn" title="Minimize" onClick={() => win?.minimize()}>
            <IconWinMin size={12} />
          </button>
          <button
            className="winctl__btn"
            title={maxed ? 'Restore' : 'Maximize'}
            onClick={() => win?.toggleMaximize()}
          >
            {maxed ? <IconWinRestore size={12} /> : <IconWinMax size={12} />}
          </button>
          <button
            className="winctl__btn winctl__btn--close"
            title="Close"
            onClick={() => win?.close()}
          >
            <IconClose size={12} />
          </button>
        </div>
      </div>
    </header>
  );
}
