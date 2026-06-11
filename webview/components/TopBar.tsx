import { useEffect, useState } from 'react';
import { win } from '../bridge';
import {
  IconBoard,
  IconBranch,
  IconChevron,
  IconClose,
  IconGraph,
  IconSidebar,
  IconSparkle,
  IconWinMax,
  IconWinMin,
  IconWinRestore,
} from '../icons';

export function TopBar({
  project,
  session,
  branch,
  onToggleSidebar,
  sidebarCollapsed,
  onBack,
  onForward,
  canBack,
  canForward,
  onOpenBoard,
  onOpenArchitecture,
}: {
  project: string;
  session: string;
  branch?: string;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  onOpenBoard: () => void;
  onOpenArchitecture: () => void;
}) {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaxed);
    return win.onMaximizeChange(setMaxed);
  }, []);

  return (
    <header className="topbar">
      <div className="topbar__left">
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

      <div className="topbar__crumbs">
        <IconSparkle className="crumb__spark" />
        <span className="crumb">{session}</span>
        <span className="crumb__sep">/</span>
        <span className="crumb crumb--dim">{project}</span>
        {branch && (
          <span className="crumb__branch">
            <IconBranch size={12} /> {branch}
          </span>
        )}
      </div>

      <div className="topbar__right">
        <button className="iconbtn" title="Architecture canvas" onClick={onOpenArchitecture}>
          <IconGraph size={15} />
        </button>
        <button className="iconbtn" title="Feature board" onClick={onOpenBoard}>
          <IconBoard size={15} />
        </button>
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
