import type { JSX as ReactJSX } from 'react';
import { useEffect, useState } from 'react';
import { attentionChipLabel, attentionEntries, type SnoozeMap } from '../../src/attention';
import type { McpAttentionItem } from '../../src/conduit-mcp/types';
import type { Session } from '../../src/types';
import { win } from '../bridge';
import { CENTER_VIEWS, type CenterView } from '../center-view';
import { MCP_STR } from '../conduit-mcp-strings';
import {
  IconBoard,
  IconChevron,
  IconClose,
  IconDoc,
  IconGraph,
  IconSearch,
  IconWinMax,
  IconWinMin,
  IconWinRestore,
} from '../icons';
import { isMac } from '../shortcuts';

const VIEW_ICON: Record<CenterView, ReactJSX.Element> = {
  editor: <IconDoc size={14} />,
  board: <IconBoard size={14} />,
  canvas: <IconGraph size={14} />,
};

const NO_ITEMS: readonly McpAttentionItem[] = [];
const NO_SNOOZE: SnoozeMap = new Map();

export function TopBar({
  isDev,
  onOpenSearch,
  onBack,
  onForward,
  canBack,
  canForward,
  centerView,
  onSelectView,
  sessions,
  onFocusAttention,
  attentionItems = NO_ITEMS,
  snoozed = NO_SNOOZE,
  onOpenThread,
  onContextMenu,
}: {
  isDev?: boolean;
  // Open the omni-search overlay (also bound to Mod+P). The center pill triggers it.
  onOpenSearch: () => void;
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
  /** Messaging's own reasons (urgent waiting, a message for you, …) join the count. */
  attentionItems?: readonly McpAttentionItem[];
  /** The same Snooze map the rail uses, so a snoozed session's items hide with it. */
  snoozed?: SnoozeMap;
  /** The chip's message entry opens its thread. */
  onOpenThread?: (threadId: string) => void;
  // Right-click the top bar to open the panel show/hide menu.
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaxed);
    return win.onMaximizeChange(setMaxed);
  }, []);

  const entries = attentionEntries(sessions, attentionItems, snoozed, Date.now());
  const chipLabel = attentionChipLabel(entries.length);
  const first = entries[0];
  const reason =
    first?.reason && first.handle ? MCP_STR.attention[first.reason](first.handle) : null;
  const firstName = first?.sessionId
    ? sessions.find((s) => s.id === first.sessionId)?.name
    : undefined;
  const chipTitle = reason ?? (firstName ? `Go to ${firstName}` : undefined);
  const onChip = () => {
    if (!first) return;
    if (first.kind === 'message' && first.threadId && onOpenThread) onOpenThread(first.threadId);
    else if (first.sessionId) onFocusAttention(first.sessionId);
  };

  const logo = (
    <img
      src={isDev ? './icon-dev.png' : './icon.png'}
      alt={isDev ? 'Conduit (dev)' : 'Conduit'}
      title={isDev ? "Development build — isolated 'Conduit (dev)' profile" : undefined}
      className="topbar__logo"
    />
  );

  // Labelled segmented control: Board and Canvas were unlabelled icons in a corner
  // and nobody found them (brief §7.8), so the words are not optional.
  const viewswitch = (
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
  );

  const nav = (
    <div className="topbar__nav">
      <button className="iconbtn iconbtn--rot" title="Back" disabled={!canBack} onClick={onBack}>
        <IconChevron />
      </button>
      <button className="iconbtn" title="Forward" disabled={!canForward} onClick={onForward}>
        <IconChevron />
      </button>
    </div>
  );

  const attnchipEl = chipLabel ? (
    <button type="button" className="attnchip" title={chipTitle} onClick={onChip}>
      <span className="attnchip__dot" aria-hidden />
      {chipLabel}
      {reason && (
        <span className="attnchip__reason">
          <span className="sr-only">, </span>
          {reason}
        </span>
      )}
    </button>
  ) : null;

  const winctl = (
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
  );

  return (
    <header className={`topbar${isMac ? ' topbar--mac' : ''}`} onContextMenu={onContextMenu}>
      <div className="topbar__left">
        {isMac ? (
          nav
        ) : (
          <>
            {logo}
            {viewswitch}
          </>
        )}
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
        {isMac ? (
          <>
            {attnchipEl}
            {viewswitch}
            {logo}
          </>
        ) : (
          <>
            {nav}
            {attnchipEl}
            {winctl}
          </>
        )}
      </div>
    </header>
  );
}
