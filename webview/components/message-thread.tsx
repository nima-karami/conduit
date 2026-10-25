import { useEffect, useRef, useState } from 'react';
import {
  type AttachmentRecord,
  type Handle,
  HUMAN_HANDLE,
  THREAD_AGENT_LIMIT,
} from '../../src/conduit-mcp/types';
import type { McpThreadMessage, McpThreadView } from '../../src/conduit-mcp/ui-types';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconDoc, IconWarning } from '../icons';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { AttachmentViewModal } from './attachment-view-modal';
import { ContextMenu, type MenuState } from './context-menu';

export interface MessageThreadProps {
  api: ConduitMcpApi;
  threadId: string;
  onReply(r: { threadId: string; to: Handle[] }): void;
}

/** Spec §10: stamps are ISO-8601 UTC in the store and locale-formatted for the reader. */
const STAMP = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const unreadForYou = (m: McpThreadMessage) => {
  const st = m.recipients[HUMAN_HANDLE]?.status;
  return st !== undefined && st !== 'read' && st !== 'expired';
};

/** Thread view (spec §8 Thread, §9): a `log` of `article`s, each with its per-recipient states. */
export function MessageThread({ api, threadId, onReply }: MessageThreadProps) {
  const [view, setView] = useState<McpThreadView | null | undefined>(undefined);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [opened, setOpened] = useState<{ messageId: string; att: AttachmentRecord } | null>(null);
  const markedRef = useRef(new Set<string>());
  const logRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);

  // Re-read on every state broadcast: recipient states (noticed, read) change without changing
  // the thread's summary, and the broadcast is already coalesced host-side.
  const stateStamp = api.state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: stateStamp is the refetch trigger.
  useEffect(() => {
    let live = true;
    void api.getThread(threadId).then((v) => {
      if (live) setView(v);
    });
    return () => {
      live = false;
    };
  }, [api.getThread, threadId, stateStamp]);

  // Opening a thread reads it: the human's unread messages in it are marked read, once each.
  useEffect(() => {
    if (!view) return;
    const ids = view.messages
      .filter((m) => unreadForYou(m) && !markedRef.current.has(m.messageId))
      .map((m) => m.messageId);
    for (const id of ids) markedRef.current.add(id);
    api.markRead(ids);
  }, [view, api.markRead]);

  // Opening a thread moves focus to its first message once, not on every refetch (spec §10).
  useEffect(() => {
    if (!view || focusedRef.current) return;
    focusedRef.current = true;
    logRef.current?.querySelector<HTMLElement>('article')?.focus();
  }, [view]);

  if (view === undefined) {
    return <div className="mcpmsg-thread mcpmsg-thread--loading" aria-busy="true" />;
  }
  if (view === null) {
    return <p className="mcpmsg-thread__gone">{MCP_STR.threadGone}</p>;
  }

  const participants = [...new Set(view.messages.flatMap((m) => [m.from, ...m.to]))];
  const replyTo = participants.filter((h) => h !== HUMAN_HANDLE);

  return (
    <div className="mcpmsg-thread">
      <div ref={logRef} className="mcpmsg-thread__log" role="log" aria-label={MCP_STR.thread}>
        {view.messages.map((m) => (
          <article
            key={m.messageId}
            className={`mcpmsg-msg${m.priority === 'urgent' ? ' mcpmsg-msg--urgent' : ''}`}
            // Spec §9: Tab follows messages.
            tabIndex={0}
            aria-label={`${MCP_STR.from(m.from)} ${MCP_STR.to(m.to)}, ${MCP_STR.kind[m.kind]}, ${MCP_STR.priority[m.priority]}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    label: MCP_STR.copyBody,
                    onClick: () => void navigator.clipboard?.writeText(m.body),
                  },
                  {
                    label: MCP_STR.copyId,
                    onClick: () => void navigator.clipboard?.writeText(m.messageId),
                  },
                ],
              });
            }}
          >
            <header className="mcpmsg-msg__head">
              <span className="mcpmsg-msg__route">
                <span className="mcpmsg-msg__from">{m.from}</span>
                <span className="mcpmsg-msg__arrow" aria-hidden>
                  →
                </span>
                <span className="mcpmsg-msg__to">{m.to.join(', ')}</span>
              </span>
              <span className="mcpmsg-chip">{MCP_STR.kind[m.kind]}</span>
              {m.priority !== 'normal' && (
                <span className={`mcpmsg-chip mcpmsg-chip--${m.priority}`}>
                  {m.priority === 'urgent' && <IconWarning size={11} />}
                  {MCP_STR.priority[m.priority]}
                </span>
              )}
              <time className="mcpmsg-msg__time" dateTime={m.sentAt}>
                {STAMP.format(Date.parse(m.sentAt))}
              </time>
            </header>
            {m.subject && <p className="mcpmsg-msg__subject">{m.subject}</p>}
            {/* The body's direction follows its own content (§10 RTL). */}
            <p className="mcpmsg-msg__body" dir="auto">
              {m.body}
            </p>
            {m.attachments.length > 0 && (
              <ul className="mcpmsg-msg__atts">
                {m.attachmentsExpired ? (
                  <li className="mcpmsg-att mcpmsg-att--expired">{MCP_STR.attachmentExpired}</li>
                ) : (
                  m.attachments.map((a) => (
                    <li key={a.attachmentId}>
                      <button
                        type="button"
                        className="mcpmsg-att"
                        aria-label={`${MCP_STR.openAttachment}: ${a.name}`}
                        onClick={() => setOpened({ messageId: m.messageId, att: a })}
                      >
                        <IconDoc size={12} />
                        <span className="mcpmsg-att__name">{a.name}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
            <ul className="mcpmsg-msg__rcpts">
              {Object.entries(m.recipients).map(([h, r]) => (
                <li key={h} className={`mcpmsg-rcpt mcpmsg-rcpt--${r.status}`}>
                  {h}: {MCP_STR.status[r.status]}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      {view.paused && (
        <div className="mcpmsg-thread__paused" role="status">
          <span>{MCP_STR.paused(THREAD_AGENT_LIMIT)}</span>
          <button type="button" className="btn btn--sm" onClick={() => api.allowMore(threadId)}>
            {MCP_STR.allowMore}
          </button>
        </div>
      )}
      <div className="mcpmsg-thread__actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={replyTo.length === 0}
          onClick={() => onReply({ threadId, to: replyTo })}
        >
          {MCP_STR.reply}
        </button>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {opened && (
        <AttachmentViewModal
          api={api}
          messageId={opened.messageId}
          attachment={opened.att}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  );
}
