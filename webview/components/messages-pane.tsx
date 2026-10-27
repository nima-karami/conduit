import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { needsSetup } from '../../src/conduit-mcp/install-types';
import { type Handle, HUMAN_HANDLE } from '../../src/conduit-mcp/types';
import type { McpThreadSummary, McpUiState } from '../../src/conduit-mcp/ui-types';
import type { Session } from '../../src/types';
import { mcpInstallStatus } from '../bridge';
import { MCP_STR } from '../conduit-mcp-strings';
import {
  composeTargets,
  newMessageCount,
  threadAccessibleName,
  threadTitle,
  visibleThreads,
} from '../conduit-mcp-view-model';
import { IconChevron, IconClose, IconPlus, IconWarning } from '../icons';
import { log } from '../log';
import { relativeTime } from '../relative-time';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { ContextMenu, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { MessageCompose } from './message-compose';
import { MessageThread } from './message-thread';

export interface MessagesPaneProps {
  api: ConduitMcpApi;
  sessions: readonly Session[];
  filterHandle: Handle | null;
  onClearFilter(): void;
  onOpenSettings(): void;
  initialThreadId: string | null;
}

/** §10: one summary per 5 s at most, so a burst of agent traffic is one announcement. */
const ANNOUNCE_EVERY_MS = 5_000;
const SKELETON_ROWS = 4;
const ZWSP = String.fromCharCode(0x200b);
const STAMP = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type View =
  | { t: 'list' }
  | { t: 'thread'; threadId: string }
  | { t: 'compose'; replyTo: { threadId: string; to: Handle[] } | null; back: View };

/**
 * The polite live region's text: new-message counts, throttled (§10). A repeat of the text on
 * screen alternates a zero-width suffix, so the region still mutates and is read again.
 */
function useNewMessageAnnouncer(state: McpUiState | null): string {
  const [text, setText] = useState('');
  const prev = useRef<McpUiState | null>(state);
  const pending = useRef(0);
  const last = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!state) return;
    const n = newMessageCount(prev.current, state);
    prev.current = state;
    if (n <= 0) return;
    pending.current += n;
    const flush = () => {
      timer.current = null;
      const said = MCP_STR.newMessages(pending.current);
      setText((cur) => (cur === said ? `${said}${ZWSP}` : said));
      pending.current = 0;
      last.current = Date.now();
    };
    const wait = last.current + ANNOUNCE_EVERY_MS - Date.now();
    if (wait <= 0) flush();
    else if (!timer.current) timer.current = setTimeout(flush, wait);
  }, [state]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return text;
}

function ThreadRow({
  t,
  id,
  active,
  onOpen,
  onHover,
  onMenu,
}: {
  t: McpThreadSummary;
  id: string;
  active: boolean;
  onOpen(): void;
  onHover(): void;
  onMenu(e: React.MouseEvent): void;
}) {
  const at = Date.parse(t.lastAt);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-label={threadAccessibleName(t)}
      className={`mcpmsg-row${active ? ' mcpmsg-row--active' : ''}${
        t.unreadForYou ? ' mcpmsg-row--unread' : ''
      }`}
      onClick={onOpen}
      onMouseEnter={onHover}
      onContextMenu={onMenu}
    >
      <span className="mcpmsg-row__dot" aria-hidden />
      <span className="mcpmsg-row__main">
        <span className="mcpmsg-row__title">{threadTitle(t)}</span>
        <span className="mcpmsg-row__who">{t.participants.join(', ')}</span>
      </span>
      <span className="mcpmsg-row__side">
        {t.topPriority === 'urgent' && (
          <span className="mcpmsg-chip mcpmsg-chip--urgent">
            <IconWarning size={11} />
            {MCP_STR.priority.urgent}
          </span>
        )}
        {t.paused && <span className="mcpmsg-chip">{MCP_STR.pausedShort}</span>}
        <time className="mcpmsg-row__time" dateTime={t.lastAt} title={STAMP.format(at)}>
          {relativeTime(at)}
        </time>
      </span>
    </div>
  );
}

/** Failure and loading both degrade to the plain first-run copy (install spec §2.6). */
function SetupEmptyState({ onOpenSettings }: { onOpenSettings(): void }) {
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    let active = true;
    mcpInstallStatus(null).then(
      (status) => {
        if (active) setSetup(needsSetup(status));
      },
      (error: unknown) => {
        log.warn('mcp-install', 'status read failed', { error: String(error) });
        if (active) setSetup(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (!setup) return <EmptyState variant="panel" title={MCP_STR.firstRun} />;
  return (
    <EmptyState
      variant="panel"
      title={MCP_STR.install.setupCopy}
      action={
        <button type="button" className="btn btn--sm" onClick={onOpenSettings}>
          {MCP_STR.install.setupButton}
        </button>
      }
    />
  );
}

/**
 * The Messages tab body (docs/specs/2026-10-25-conduit-mcp-server.md §8–§10). The live region
 * sits outside the view switch: one region, mounted for the pane's life.
 */
export function MessagesPane(props: MessagesPaneProps) {
  const { state } = props.api;
  const announcement = useNewMessageAnnouncer(state);
  return (
    <div className="mcpmsg" aria-busy={!state || state.loading || undefined}>
      <MessagesView {...props} />
      <span className="sr-only" aria-live="polite" role="status">
        {announcement}
      </span>
    </div>
  );
}

function MessagesView({
  api,
  sessions,
  filterHandle,
  onClearFilter,
  onOpenSettings,
  initialThreadId,
}: MessagesPaneProps) {
  const { state } = api;
  const [view, setView] = useState<View>(() =>
    initialThreadId ? { t: 'thread', threadId: initialThreadId } : { t: 'list' },
  );
  const [unreadOnly, setUnreadOnly] = useState(false);
  // By id, not index: a thread arriving above the active one must not move the selection.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const newMessageRef = useRef<HTMLButtonElement>(null);
  // Where focus lands after the next view switch (spec §10); null leaves it alone.
  const focusNext = useRef<'list' | 'new-message' | null>(null);

  useEffect(() => {
    if (initialThreadId) setView({ t: 'thread', threadId: initialThreadId });
  }, [initialThreadId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a view switch is the trigger.
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'list') (listRef.current ?? newMessageRef.current)?.focus();
    else if (target === 'new-message') newMessageRef.current?.focus();
  }, [view]);

  if (!state || state.loading) {
    return (
      <div className="mcpmsg-skeleton">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows, never reordered.
          <span key={i} className="mcpmsg-skeleton__row" />
        ))}
      </div>
    );
  }
  if (!state.enabled) {
    return (
      <EmptyState
        variant="panel"
        title={MCP_STR.off}
        action={
          <button type="button" className="btn btn--sm" onClick={onOpenSettings}>
            {MCP_STR.openSettings}
          </button>
        }
      />
    );
  }
  if (state.storeError) {
    return (
      <EmptyState
        variant="panel"
        role="alert"
        title={MCP_STR.loadError}
        hint={state.storeError}
        action={
          <button type="button" className="btn btn--sm" onClick={() => api.retry()}>
            {MCP_STR.retry}
          </button>
        }
      />
    );
  }

  const targets = composeTargets(sessions, state);

  if (view.t === 'compose') {
    const back = view.back;
    return (
      <MessageCompose
        api={api}
        targets={targets}
        replyTo={view.replyTo}
        onDone={() => {
          if (back.t === 'list') focusNext.current = 'new-message';
          setView(back);
        }}
      />
    );
  }

  if (view.t === 'thread') {
    const summary = state.threads.find((t) => t.threadId === view.threadId);
    const toList = () => {
      setActiveThreadId(view.threadId);
      focusNext.current = 'list';
      setView({ t: 'list' });
    };
    return (
      <>
        <div className="mcpmsg__bar">
          <button
            type="button"
            className="iconbtn iconbtn--rot"
            title={MCP_STR.back}
            aria-label={MCP_STR.back}
            onClick={toList}
          >
            <IconChevron size={14} />
          </button>
          <span className="mcpmsg__bartitle">
            {summary ? threadTitle(summary) : MCP_STR.thread}
          </span>
        </div>
        <div className="mcpmsg__scroll">
          <MessageThread
            api={api}
            threadId={view.threadId}
            onReply={(replyTo) => setView({ t: 'compose', replyTo, back: view })}
          />
        </div>
      </>
    );
  }

  const threads = visibleThreads(state.threads, { unreadOnly, handle: filterHandle });
  const activeIndex = Math.max(
    threads.findIndex((t) => t.threadId === activeThreadId),
    0,
  );
  const openThread = (t: McpThreadSummary) => setView({ t: 'thread', threadId: t.threadId });
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (threads.length === 0) return;
    const go = (i: number) => {
      e.preventDefault();
      setActiveThreadId(threads[i].threadId);
      document.getElementById(optionId(i))?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(Math.min(activeIndex + 1, threads.length - 1));
    else if (e.key === 'ArrowUp') go(Math.max(activeIndex - 1, 0));
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(threads.length - 1);
    else if (e.key === 'Enter') {
      e.preventDefault();
      openThread(threads[activeIndex]);
    }
  };

  const markThreadRead = async (threadId: string) => {
    const v = await api.getThread(threadId);
    if (!v) return;
    api.markRead(
      v.messages
        .filter((m) => {
          const st = m.recipients[HUMAN_HANDLE]?.status;
          return st !== undefined && st !== 'read' && st !== 'expired';
        })
        .map((m) => m.messageId),
    );
  };

  const toolbar = (
    <div className="mcpmsg__bar">
      <button
        ref={newMessageRef}
        type="button"
        className="btn btn--primary btn--sm"
        onClick={() => setView({ t: 'compose', replyTo: null, back: { t: 'list' } })}
      >
        <IconPlus size={12} />
        {MCP_STR.newMessage}
      </button>
      {state.threads.length > 0 && (
        <button
          type="button"
          className={`btn btn--sm mcpmsg__filter${unreadOnly ? ' mcpmsg__filter--on' : ''}`}
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((v) => !v)}
        >
          {MCP_STR.unreadOnly}
        </button>
      )}
      {filterHandle && (
        <span className="mcpmsg__scope">
          <span className="mcpmsg__scopetext">{MCP_STR.filteredTo(filterHandle)}</span>
          <button
            type="button"
            className="iconbtn"
            title={MCP_STR.clearFilter}
            aria-label={MCP_STR.clearFilter}
            onClick={onClearFilter}
          >
            <IconClose size={11} />
          </button>
        </span>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (state.threads.length === 0) {
    body = <SetupEmptyState onOpenSettings={onOpenSettings} />;
  } else if (threads.length === 0) {
    body = (
      <EmptyState
        variant="panel"
        title={MCP_STR.noUnread}
        action={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setUnreadOnly(false);
              if (filterHandle) onClearFilter();
            }}
          >
            {MCP_STR.showAll}
          </button>
        }
      />
    );
  } else {
    body = (
      <div
        ref={listRef}
        className="mcpmsg__list"
        role="listbox"
        aria-label={MCP_STR.threadList}
        tabIndex={0}
        aria-activedescendant={optionId(activeIndex)}
        onKeyDown={onKeyDown}
      >
        {threads.map((t, i) => (
          <ThreadRow
            key={t.threadId}
            t={t}
            id={optionId(i)}
            active={i === activeIndex}
            onOpen={() => openThread(t)}
            onHover={() => setActiveThreadId(t.threadId)}
            onMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    label: MCP_STR.markRead,
                    disabled: !t.unreadForYou,
                    onClick: () => void markThreadRead(t.threadId),
                  },
                ],
              });
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      {toolbar}
      <div className="mcpmsg__scroll">{body}</div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
