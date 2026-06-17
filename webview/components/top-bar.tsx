import { useEffect, useState } from 'react';
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
  onOpenSearch,
  onToggleSidebar,
  sidebarCollapsed,
  onBack,
  onForward,
  canBack,
  canForward,
  centerView,
  onSelectView,
  onContextMenu,
}: {
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
  // Right-click the top bar to open the panel show/hide menu.
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaxed);
    return win.onMaximizeChange(setMaxed);
  }, []);

  return (
    <header className="topbar" onContextMenu={onContextMenu}>
      <div className="topbar__left">
        <img src="./icon.png" alt="Conduit" className="topbar__logo" />
        <button
          className="iconbtn"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleSidebar}
        >
          <IconSidebar />
        </button>
        <button className="iconbtn iconbtn--rot" title="Back" disabled={!canBack} onClick={onBack}>
          <IconChevron />
        </button>
        <button className="iconbtn" title="Forward" disabled={!canForward} onClick={onForward}>
          <IconChevron />
        </button>
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
                aria-label={v.label}
                onClick={() => onSelectView(v.id)}
              >
                {VIEW_ICON[v.id]}
              </button>
            );
          })}
        </div>
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
