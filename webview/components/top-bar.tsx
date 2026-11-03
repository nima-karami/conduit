import { MessageSquare } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { ChangesModel } from '../../src/changes-view-model';
import type { McpUiState } from '../../src/conduit-mcp/ui-types';
import type { RightPaneTab } from '../../src/settings';
import { win } from '../bridge';
import { CHROME_STR } from '../chrome-strings';
import { tabBadge } from '../conduit-mcp-view-model';
import {
  IconBranch,
  IconChevron,
  IconClose,
  IconDoc,
  IconSearch,
  IconWarning,
  IconWinMax,
  IconWinMin,
  IconWinRestore,
} from '../icons';
import { getReviewNav, type ReviewNavModel, subscribeReviewNav } from '../review-nav-store';
import { useSettings } from '../settings';
import { ariaKeyShortcut, comboLabel, isMac } from '../shortcuts';
import { useWorkbenchChromeState } from '../workbench-chrome-state';

/** The Changes toggle's count: review mode counts its navigator's files, otherwise the model's. */
export function changesBadgeCount(
  reviewMode: boolean,
  navModel: ReviewNavModel | null,
  changesModel: ChangesModel | undefined,
): number {
  if (reviewMode && navModel) return navModel.files.length;
  return changesModel?.kind === 'ready' ? changesModel.count : 0;
}

const VIEWS: readonly { id: RightPaneTab; icon: ReactNode }[] = [
  { id: 'files', icon: <IconDoc size={14} /> },
  { id: 'changes', icon: <IconBranch size={14} /> },
  { id: 'messages', icon: <MessageSquare size={14} aria-hidden /> },
];

interface Badge {
  count: number;
  urgent: boolean;
  text: string;
}

function ViewToggle({
  id,
  icon,
  badge,
}: {
  id: RightPaneTab;
  icon: ReactNode;
  badge: Badge | null;
}) {
  const chrome = useWorkbenchChromeState();
  const descId = useId();
  const pressed = chrome.rightOpen && chrome.rightTab === id;
  const label = CHROME_STR.view[id];
  return (
    <button
      type="button"
      className="topbar__toggle"
      data-right-view={id}
      aria-label={label}
      aria-pressed={pressed}
      aria-controls="right-pane"
      aria-describedby={badge ? descId : undefined}
      title={badge ? `${label} — ${badge.text}` : label}
      onClick={() => chrome.togglePanel(id)}
    >
      {icon}
      {badge && (
        <>
          <span
            className={`topbar__badge${badge.urgent ? ' topbar__badge--urgent' : ''}`}
            aria-hidden
          >
            {badge.urgent && <IconWarning size={10} />}
            {badge.count.toLocaleString()}
          </span>
          <span id={descId} className="sr-only">
            {badge.text}
          </span>
        </>
      )}
    </button>
  );
}

export function TopBar({
  isDev,
  onOpenSearch,
  onBack,
  onForward,
  canBack,
  canForward,
  changesModel,
  reviewMode = false,
  mcpState = null,
  unreadOutsideScope = 0,
  onContextMenu,
}: {
  isDev?: boolean;
  // Open the omni-search overlay (also bound to Mod+P). The center pill triggers it.
  onOpenSearch: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  /** The Changes toggle's badge source, as the old Changes tab read it. */
  changesModel?: ChangesModel;
  reviewMode?: boolean;
  /** The Messages toggle's unread/urgent badge source. */
  mcpState?: McpUiState | null;
  unreadOutsideScope?: number;
  // Right-click the top bar to open the panel show/hide menu.
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [maxed, setMaxed] = useState(false);
  const navModel = useSyncExternalStore(subscribeReviewNav, getReviewNav, getReviewNav);
  const { settings } = useSettings();
  const searchCombo = comboLabel('openSearch', settings.shortcuts);

  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaxed);
    return win.onMaximizeChange(setMaxed);
  }, []);

  const changesCount = changesBadgeCount(reviewMode, navModel, changesModel);
  const mcpBadge = mcpState ? tabBadge(mcpState) : null;
  const badges: Record<RightPaneTab, Badge | null> = {
    files: null,
    changes:
      changesCount > 0
        ? { count: changesCount, urgent: false, text: CHROME_STR.changesBadge(changesCount) }
        : null,
    messages:
      mcpBadge && mcpState
        ? {
            count: mcpBadge.count,
            urgent: mcpBadge.urgent,
            text: CHROME_STR.messagesBadge(mcpBadge.count, mcpState.youUrgent, unreadOutsideScope),
          }
        : null,
  };

  const identity = (
    <div className="topbar__identity">
      <img
        src={isDev ? './icon-dev.png' : './icon.png'}
        alt=""
        title={isDev ? CHROME_STR.devTitle : undefined}
        className="topbar__logo"
      />
      <span className="topbar__wordmark">{CHROME_STR.wordmark}</span>
    </div>
  );

  const nav = (
    <div className="topbar__nav">
      <button
        type="button"
        className="iconbtn iconbtn--rot"
        title={CHROME_STR.back}
        aria-label={CHROME_STR.back}
        disabled={!canBack}
        onClick={onBack}
      >
        <IconChevron />
      </button>
      <button
        type="button"
        className="iconbtn"
        title={CHROME_STR.forward}
        aria-label={CHROME_STR.forward}
        disabled={!canForward}
        onClick={onForward}
      >
        <IconChevron />
      </button>
    </div>
  );

  const winctl = (
    <div className="winctl">
      <button
        type="button"
        className="winctl__btn"
        title={CHROME_STR.minimize}
        aria-label={CHROME_STR.minimize}
        onClick={() => win?.minimize()}
      >
        <IconWinMin size={12} />
      </button>
      <button
        type="button"
        className="winctl__btn"
        title={maxed ? CHROME_STR.restore : CHROME_STR.maximize}
        aria-label={maxed ? CHROME_STR.restore : CHROME_STR.maximize}
        onClick={() => win?.toggleMaximize()}
      >
        {maxed ? <IconWinRestore size={12} /> : <IconWinMax size={12} />}
      </button>
      <button
        type="button"
        className="winctl__btn winctl__btn--close"
        title={CHROME_STR.close}
        aria-label={CHROME_STR.close}
        onClick={() => win?.close()}
      >
        <IconClose size={12} />
      </button>
    </div>
  );

  return (
    <header className={`topbar${isMac ? ' topbar--mac' : ''}`} onContextMenu={onContextMenu}>
      <div className="topbar__left">
        {identity}
        {nav}
      </div>

      {/* Center omni-search pill (R4.13): click or Mod+P opens the overlay across
          Sessions / Agents / Files (R5.4). */}
      <div className="topbar__center">
        <button
          type="button"
          className="omnibar"
          onClick={onOpenSearch}
          title={searchCombo ? `${CHROME_STR.search} (${searchCombo})` : CHROME_STR.search}
          aria-label={CHROME_STR.search}
          aria-keyshortcuts={ariaKeyShortcut('openSearch', settings.shortcuts)}
        >
          <IconSearch size={14} className="omnibar__icon" />
          <span className="omnibar__placeholder">{CHROME_STR.searchPlaceholder}</span>
        </button>
      </div>

      <div className="topbar__right">
        <div className="topbar__toggles" role="group" aria-label={CHROME_STR.panelGroup}>
          {VIEWS.map((v) => (
            <ViewToggle key={v.id} id={v.id} icon={v.icon} badge={badges[v.id]} />
          ))}
        </div>
        {!isMac && winctl}
      </div>
    </header>
  );
}
