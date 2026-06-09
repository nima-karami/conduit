import { IconSidebar, IconChevron, IconSparkle, IconBranch } from '../icons';

export function TopBar({ project, session, branch }: { project: string; session: string; branch?: string }) {
  return (
    <header className="topbar">
      <div className="topbar__left">
        <button className="iconbtn" title="Toggle sidebar"><IconSidebar /></button>
        <button className="iconbtn iconbtn--rot"><IconChevron /></button>
        <button className="iconbtn"><IconChevron /></button>
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
        <span className="winchip" />
        <span className="winchip" />
        <span className="winchip winchip--accent" />
      </div>
    </header>
  );
}
