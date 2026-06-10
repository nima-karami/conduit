import { useEffect, useState } from 'react';
import {
  IconSidebar, IconChevron, IconSparkle, IconBranch,
  IconWinMin, IconWinMax, IconWinRestore, IconClose,
} from '../icons';
import { win } from '../bridge';

export function TopBar({
  project, session, branch,
  onToggleSidebar, sidebarCollapsed,
  onBack, onForward, canBack, canForward,
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
        <button className="iconbtn iconbtn--rot" title="Back" disabled={!canBack} onClick={onBack}><IconChevron /></button>
        <button className="iconbtn" title="Forward" disabled={!canForward} onClick={onForward}><IconChevron /></button>
      </div>

      <div className="topbar__crumbs">
        <IconSparkle className="crumb__spark" />
        <span className="crumb">{session}</span>
        <span className="crumb__sep">/</span>
        <span className="crumb crumb--dim">{project}</span>
        {branch && (
          <>
            <span className="crumb__branch"><IconBranch size={12} /> {branch}</span>
          </>
        )}
      </div>

      <div className="topbar__right">
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
          <button className="winctl__btn winctl__btn--close" title="Close" onClick={() => win?.close()}>
            <IconClose size={12} />
          </button>
        </div>
      </div>
    </header>
  );
}
