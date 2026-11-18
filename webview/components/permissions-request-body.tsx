import { useId, useRef, useState } from 'react';
import type { GrantChoice } from '../../src/conduit-mcp/grant-store';
import type { PermissionAnswer } from '../../src/conduit-mcp/policy-types';
import type {
  OwnerPermissionView,
  PermissionAnswerResult,
  RemoteRequestFacts,
  RequestAnswerResult,
} from '../../src/conduit-mcp/request-types';

type RemoteAnswer = { outcome: 'allowed'; grant?: GrantChoice } | { outcome: 'denied' };

export type PermissionsRequestBodyProps =
  | {
      kind: 'local';
      guarded?: boolean;
      request: OwnerPermissionView;
      answer(requestId: string, answer: PermissionAnswer): Promise<PermissionAnswerResult>;
    }
  | {
      kind: 'remote';
      requestId: string;
      permission: NonNullable<RemoteRequestFacts['permission']>;
      machineName: string;
      stale: boolean;
      answerable: boolean;
      answer(requestId: string, answer: RemoteAnswer): Promise<RequestAnswerResult>;
    };

const remoteGrant: GrantChoice = { who: 'peer', on: 'target', for: 'until-revoked' };
const narrowGrant: GrantChoice = { who: 'session', on: 'target', for: 'session-end' };
const sameChoice = (a: GrantChoice, b: GrantChoice) =>
  a.who === b.who && a.on === b.on && a.for === b.for;
const whoLabel: Record<GrantChoice['who'], string> = {
  session: 'This session',
  cli: 'This agent kind',
  peer: 'This peer',
};
const onLabel: Record<GrantChoice['on'], string> = {
  target: 'This target only',
  folder: 'This folder',
  anywhere: 'Anywhere',
};
const forLabel: Record<GrantChoice['for'], string> = {
  'session-end': 'Until this session ends',
  '1h': '1 hour',
  '24h': '24 hours',
  'until-revoked': 'Until revoked',
};

export function PermissionsRequestBody(p: PermissionsRequestBodyProps) {
  const reasonId = useId();
  const [panel, setPanel] = useState<'allow' | 'deny' | null>(null);
  const [reason, setReason] = useState('');
  const [selection, setSelection] = useState<GrantChoice | null>(() =>
    p.kind === 'local' && p.request.choices.some((c) => sameChoice(c, narrowGrant))
      ? narrowGrant
      : null,
  );
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const local = p.kind === 'local' ? p.request : null;
  const late = local?.state === 'expired';
  const available =
    p.kind === 'local'
      ? p.request.answerable && (p.request.state === 'open' || late)
      : p.answerable && !p.stale;
  const disabled = !available || pending || receipt !== null || (p.kind === 'local' && !!p.guarded);
  const choices = local?.choices ?? [];
  const selected = selection && choices.find((c) => sameChoice(c, selection));

  const submit = async (answer: PermissionAnswer) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      const result =
        p.kind === 'local'
          ? await p.answer(p.request.id, answer)
          : await p.answer(
              p.requestId,
              answer.outcome === 'denied'
                ? { outcome: 'denied' }
                : answer.grant
                  ? { outcome: 'allowed', grant: remoteGrant }
                  : { outcome: 'allowed' },
            );
      if (!result.ok) setFailure(result.message);
      else
        setReceipt(
          late
            ? 'Grant created. Ask the agent to try again; the expired action did not run.'
            : 'Answer sent.',
        );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not send the answer. Try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const update = (key: keyof GrantChoice, value: string) => {
    const base = selection ?? { who: '', on: '', for: '' };
    const next = { ...base, [key]: value };
    setSelection(next as GrantChoice);
  };

  return (
    <section className="permissions-request-body" aria-label="Permission decision">
      <p className="permissions-request-body__why">
        Why: {p.kind === 'local' ? p.request.why : p.permission.why} ·{' '}
        <code>{p.kind === 'local' ? p.request.tool : p.permission.tool}</code>
      </p>
      {p.kind === 'remote' && (
        <p className="permissions-request-body__remote">On {p.machineName}</p>
      )}
      {!available && (
        <p className="permissions-request-body__unavailable">
          {p.kind === 'remote' && p.stale
            ? `${p.machineName} is offline. Answer when it reconnects.`
            : local?.state === 'withdrawn'
              ? `Request withdrawn${local.withdrawReason ? `: ${local.withdrawReason}` : '.'}`
              : late
                ? local?.nextTimeGrantSaved
                  ? 'This request expired. A grant was saved for next time.'
                  : 'This request expired.'
                : 'This request is no longer available to answer.'}
        </p>
      )}
      {late && available && (
        <p className="permissions-request-body__expired">
          This request expired. A grant applies only next time; the agent must retry.
        </p>
      )}
      {available && !late && (
        <div
          className="permissions-request-body__actions"
          role="group"
          aria-label="Answer permission request"
        >
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled}
            aria-expanded={panel === 'deny'}
            onClick={() => setPanel(panel === 'deny' ? null : 'deny')}
          >
            Deny ▾
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={disabled}
            onClick={() => void submit({ outcome: 'allowed' })}
          >
            Allow once
          </button>
          {(p.kind === 'local' ? choices.length > 0 : p.permission.grantable) && (
            <button
              type="button"
              className="btn btn--sm"
              disabled={disabled}
              aria-expanded={panel === 'allow'}
              onClick={() => setPanel(panel === 'allow' ? null : 'allow')}
            >
              Allow…
            </button>
          )}
        </div>
      )}
      {late && available && choices.length > 0 && (
        <button
          type="button"
          className="btn btn--sm"
          disabled={disabled}
          aria-expanded={panel === 'allow'}
          onClick={() => setPanel(panel === 'allow' ? null : 'allow')}
        >
          Allow next time
        </button>
      )}
      {panel === 'deny' && available && !late && (
        <div className="permissions-request-body__panel">
          {p.kind === 'local' && (
            <>
              <label htmlFor={reasonId}>Reason for the agent (optional)</label>
              <textarea
                id={reasonId}
                className="reqtpl-field__input"
                maxLength={120}
                value={reason}
                disabled={disabled}
                onChange={(e) => setReason(e.target.value)}
              />
            </>
          )}
          <div className="permissions-request-body__actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={disabled}
              onClick={() =>
                void submit({
                  outcome: 'denied',
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                })
              }
            >
              Deny{reason.trim() && p.kind === 'local' ? ' and send reason' : ''}
            </button>
            {p.kind === 'local' && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={disabled}
                onClick={() =>
                  void submit({
                    outcome: 'denied',
                    scope: 'session',
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  })
                }
              >
                Deny for this session
              </button>
            )}
          </div>
        </div>
      )}
      {panel === 'allow' && available && (
        <div className="permissions-request-body__panel">
          {p.kind === 'local' ? (
            <>
              {(['who', 'on', 'for'] as const).map((key) => {
                const labels = key === 'who' ? whoLabel : key === 'on' ? onLabel : forLabel;
                const values = [...new Set(choices.map((c) => c[key]))];
                const fieldId = `${reasonId}-${key}`;
                return (
                  <div key={key} className="permissions-request-body__field">
                    <label htmlFor={fieldId}>
                      {key === 'who' ? 'Who' : key === 'on' ? 'On' : 'For'}
                    </label>
                    <select
                      id={fieldId}
                      value={selection?.[key] ?? ''}
                      disabled={disabled}
                      onChange={(e) => update(key, e.target.value)}
                    >
                      <option value="">Choose…</option>
                      {values.map((value) => (
                        <option key={value} value={value}>
                          {(labels as Record<string, string>)[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
              {selected ? (
                <p className="permissions-request-body__grant">
                  Creates a grant for {whoLabel[selected.who].toLowerCase()}, on{' '}
                  {onLabel[selected.on].toLowerCase()}, {forLabel[selected.for].toLowerCase()}.
                </p>
              ) : (
                <p className="permissions-request-body__grant">
                  Choose an available combination to see the grant.
                </p>
              )}
              <div className="permissions-request-body__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setPanel(null)}
                  disabled={disabled}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={disabled || !selected}
                  onClick={() => {
                    if (selected) void submit({ outcome: 'allowed', grant: selected });
                  }}
                >
                  {late ? 'Create grant' : 'Allow'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="permissions-request-body__grant">
                Creates a grant for this peer on this target until revoked on {p.machineName}.
              </p>
              <div className="permissions-request-body__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={disabled}
                  onClick={() => setPanel(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={disabled}
                  onClick={() => void submit({ outcome: 'allowed', grant: remoteGrant })}
                >
                  Allow
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {pending && (
        <p className="permissions-request-body__status" role="status">
          Sending…
        </p>
      )}
      {receipt && (
        <p className="permissions-request-body__status" role="status">
          {receipt}
        </p>
      )}
      {failure && (
        <p className="permissions-request-body__error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
