import { useEffect, useId, useRef, useState } from 'react';
import {
  type Handle,
  HUMAN_HANDLE,
  type MessageKind,
  type Priority,
} from '../../src/conduit-mcp/types';
import { MCP_STR } from '../conduit-mcp-strings';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { SegmentedRadios } from './segmented-radios';
import { SelectField } from './select-field';

export interface MessageComposeProps {
  api: ConduitMcpApi;
  targets: Array<{ handle: Handle; label: string }>;
  replyTo: { threadId: string; to: Handle[] } | null;
  onDone(): void;
}

const PRIORITIES: readonly { id: Priority; label: string }[] = (
  ['fyi', 'normal', 'urgent'] as const
).map((id) => ({ id, label: MCP_STR.priority[id] }));
const KINDS = (['inform', 'request', 'question', 'done'] as const).map((value) => ({
  value,
  label: MCP_STR.kind[value],
}));

type Phase = { t: 'idle' } | { t: 'sending' } | { t: 'failed'; lines: string[] };

/**
 * Compose as `you` (spec §8 Compose). No attachments: human-compose attachments are cut to v1
 * (plan ruling 7), so the request never carries an `attachments` key.
 */
export function MessageCompose({ api, targets, replyTo, onDone }: MessageComposeProps) {
  const [to, setTo] = useState<Handle[]>(() =>
    (replyTo?.to ?? []).filter((h) => h !== HUMAN_HANDLE),
  );
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [kind, setKind] = useState<MessageKind>('inform');
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
  // Set once a send reached some recipients: a retry goes to the rest, in that same thread.
  const [sentThreadId, setSentThreadId] = useState<string | null>(null);
  const threadId = replyTo?.threadId ?? sentThreadId;
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const firstRecipientRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const ids = { subject: useId(), body: useId(), hint: useId() };

  // A reply already knows who it is for; the next thing to say is the message.
  useEffect(() => {
    if (replyTo) bodyRef.current?.focus();
    else (firstRecipientRef.current ?? subjectRef.current)?.focus();
  }, [replyTo]);

  // A reply's recipients may include a session that has since lost its handle: still listed,
  // so the human sees who the thread was with.
  const rows = [
    ...targets,
    ...to
      .filter((h) => !targets.some((t) => t.handle === h))
      .map((handle) => ({ handle, label: '' })),
  ];
  const canSend = phase.t !== 'sending' && to.length > 0 && body.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setPhase({ t: 'sending' });
    const result = await api.send({
      to,
      body,
      priority,
      kind,
      ...(!threadId && subject.trim() ? { subject: subject.trim() } : {}),
      ...(threadId ? { threadId } : {}),
    });
    if (!result) {
      setPhase({ t: 'failed', lines: [MCP_STR.noResponse] });
      return;
    }
    if (!result.ok) {
      setPhase({ t: 'failed', lines: [MCP_STR.refusal[result.error.code]] });
      return;
    }
    const refused = result.value.recipients.filter((r) => r.status === 'refused');
    if (refused.length === 0) {
      onDone();
      return;
    }
    if (refused.length < result.value.recipients.length) {
      setTo(refused.map((r) => r.handle));
      setSentThreadId(result.value.thread_id);
    }
    setPhase({
      t: 'failed',
      lines: refused.map((r) =>
        MCP_STR.refused(r.handle, r.reason ? MCP_STR.refusal[r.reason] : MCP_STR.sendFailed),
      ),
    });
  };

  return (
    <form
      className="mcpmsg-compose"
      aria-label={replyTo ? MCP_STR.reply : MCP_STR.newMessage}
      aria-describedby={ids.hint}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void send();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <fieldset className="mcpmsg-compose__to">
        <legend className="mcpmsg-compose__label">{MCP_STR.recipients}</legend>
        {rows.length === 0 ? (
          <p className="mcpmsg-compose__none">{MCP_STR.noRecipients}</p>
        ) : (
          rows.map((t, i) => (
            <label key={t.handle} className="mcpmsg-compose__recipient">
              <input
                ref={i === 0 ? firstRecipientRef : undefined}
                type="checkbox"
                checked={to.includes(t.handle)}
                onChange={(e) =>
                  setTo((cur) =>
                    e.target.checked ? [...cur, t.handle] : cur.filter((h) => h !== t.handle),
                  )
                }
              />
              <span className="mcpmsg-compose__handle">{t.handle}</span>
              {t.label && <span className="mcpmsg-compose__sublabel">{t.label}</span>}
            </label>
          ))
        )}
      </fieldset>
      {!threadId && (
        <div className="mcpmsg-compose__field">
          <label className="mcpmsg-compose__label" htmlFor={ids.subject}>
            {MCP_STR.subject}
          </label>
          <input
            ref={subjectRef}
            id={ids.subject}
            className="mcpmsg-compose__input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      )}
      <div className="mcpmsg-compose__row">
        <div className="mcpmsg-compose__field">
          <span className="mcpmsg-compose__label" aria-hidden>
            {MCP_STR.priorityLabel}
          </span>
          <SegmentedRadios
            label={MCP_STR.priorityLabel}
            value={priority}
            options={PRIORITIES}
            onChange={setPriority}
          />
        </div>
        <div className="mcpmsg-compose__field">
          <span className="mcpmsg-compose__label" aria-hidden>
            {MCP_STR.kindLabel}
          </span>
          <SelectField
            ariaLabel={MCP_STR.kindLabel}
            value={kind}
            options={KINDS}
            onChange={(v) => setKind(v as MessageKind)}
          />
        </div>
      </div>
      <div className="mcpmsg-compose__field">
        <label className="mcpmsg-compose__label" htmlFor={ids.body}>
          {MCP_STR.body}
        </label>
        <textarea
          ref={bodyRef}
          id={ids.body}
          className="mcpmsg-compose__body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      {phase.t === 'failed' && (
        <ul className="mcpmsg-compose__error" role="alert">
          {phase.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <div className="mcpmsg-compose__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!canSend}>
          {phase.t === 'sending' ? MCP_STR.sending : MCP_STR.send}
        </button>
        <button type="button" className="btn btn--sm" onClick={onDone}>
          {MCP_STR.cancel}
        </button>
        <span id={ids.hint} className="mcpmsg-compose__hint">
          {MCP_STR.composeHint}
        </span>
      </div>
    </form>
  );
}
