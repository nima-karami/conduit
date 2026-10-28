import { useLayoutEffect, useRef, useState } from 'react';
import {
  type AgentCli,
  BACKUP_SUFFIX,
  type CliInstallStatus,
  type McpInstallAction,
  type McpInstallRequest,
  type McpInstallResult,
  type UserInstallState,
} from '../../src/conduit-mcp/install-types';
import { MCP_STR } from '../conduit-mcp-strings';
import { STATUS_UNREADABLE } from '../mcp-install-codes';
import { ConfirmDialog } from './confirm-dialog';

export interface McpInstallRowProps {
  cli: AgentCli;
  /** null ⇒ 'checking'. */
  status: CliInstallStatus | null;
  /** A Check again is re-reading: the last status stays, buttons stay mounted. */
  checking?: boolean;
  onAct(req: McpInstallRequest): Promise<McpInstallResult | null>;
  onRecheck(): void;
  /** Focus the row's first enabled button once on mount (opened "at that CLI"). */
  focusOnMount?: boolean;
}

type RowButton =
  | { kind: 'recheck' }
  | { kind: 'act'; action: 'install' | 'uninstall'; useThis?: boolean }
  | { kind: 'replace' };

// spec 2026-10-27-conduit-mcp-install §2.3: each state's actions, in this order.
const BUTTONS: Record<UserInstallState, RowButton[]> = {
  'not-found': [{ kind: 'recheck' }],
  'not-installed': [{ kind: 'act', action: 'install' }],
  installed: [{ kind: 'act', action: 'uninstall' }],
  'other-conduit': [
    { kind: 'act', action: 'install', useThis: true },
    { kind: 'act', action: 'uninstall' },
  ],
  conflict: [{ kind: 'replace' }],
  error: [{ kind: 'recheck' }],
};

const actionOf = (b: RowButton): McpInstallAction | null =>
  b.kind === 'act' ? b.action : b.kind === 'replace' ? 'replace' : null;

interface Failure {
  action: McpInstallAction;
  code: string;
}

export function McpInstallRow({
  cli,
  status,
  checking = false,
  onAct,
  onRecheck,
  focusOnMount,
}: McpInstallRowProps) {
  const S = MCP_STR.install;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The live region speaks only after something the user did in this row; a tab open must not
  // read out four rows (spec 2026-10-27-conduit-mcp-install §10).
  const [acted, setActed] = useState(false);
  const [done, setDone] = useState(false);
  const recheckHere = useRef(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef(!!focusOnMount);

  // Runs once the buttons for the new state exist: on the first status (focusOnMount) and after
  // an action settles (spec §10, the cursor-connect precedent).
  useLayoutEffect(() => {
    if (pending || checking || status === null || !focusNext.current) return;
    focusNext.current = false;
    actionsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [pending, checking, status]);

  // Any re-read starts from a clean row: its result may contradict an earlier failure. Only the
  // row whose Check again was pressed keeps announcing.
  useLayoutEffect(() => {
    if (!checking) {
      recheckHere.current = false;
      return;
    }
    setFailure(null);
    setDone(false);
    if (!recheckHere.current) setActed(false);
  }, [checking]);

  const path = status?.user.path ?? '';

  const run = async (action: McpInstallAction) => {
    focusNext.current = true;
    setActed(true);
    setDone(false);
    setPending(true);
    const result = await onAct({ cli, scope: 'user', action });
    setDone(result?.ok === true);
    setFailure(
      result === null
        ? { action, code: 'EINVAL' }
        : result.ok
          ? null
          : { action, code: result.errorCode },
    );
    setPending(false);
  };

  const recheck = () => {
    if (checking) return;
    focusNext.current = true;
    recheckHere.current = true;
    setActed(true);
    setDone(false);
    setFailure(null);
    onRecheck();
  };

  const state = status?.user.state;
  const stateButtons = state ? BUTTONS[state] : [];
  // A retry is offered only while the failed action still fits the re-read state; otherwise the
  // state's own buttons are the way forward (ESTATE: the file changed under us).
  const retry =
    failure !== null && stateButtons.some((b) => actionOf(b) === failure.action) ? failure : null;
  const shown = retry ? stateButtons.filter((b) => actionOf(b) !== retry.action) : stateButtons;

  const unreadable = state === 'error' && status?.user.errorCode === STATUS_UNREADABLE;
  const stateText =
    status === null || checking
      ? S.state.checking
      : pending
        ? S.state.pending
        : unreadable
          ? S.unreadable
          : S.state[status.user.state];
  const detail =
    checking || pending || unreadable
      ? ''
      : failure
        ? S.actionFailed(path, failure.code)
        : state === 'error' && status?.user.errorCode
          ? S.errorDetail(status.user.errorCode)
          : '';
  const errorCode = failure?.code ?? (state === 'error' ? status?.user.errorCode : undefined);
  const spoken = !acted
    ? ''
    : done && !failure && state && !checking && !pending
      ? S.actionDone(S.state[state], path)
      : detail
        ? `${stateText} ${detail}`
        : stateText;
  // A not-found CLI has no file yet; naming its would-be path reads as if one existed.
  const showPath = path !== '' && state !== undefined && state !== 'not-found';

  const label = (b: RowButton): { text: string; aria: string } => {
    switch (b.kind) {
      case 'recheck':
        return { text: S.checkAgain, aria: S.checkAgainAria(cli) };
      case 'replace':
        return { text: S.replace, aria: S.replaceAria(cli) };
      case 'act':
        if (b.useThis) return { text: S.useThis, aria: S.adoptAria(cli) };
        return b.action === 'install'
          ? { text: S.install, aria: S.installAria(cli) }
          : { text: S.uninstall, aria: S.uninstallAria(cli) };
    }
  };
  const press = (action: McpInstallAction | null) => {
    if (action === null) recheck();
    else if (action === 'replace') setConfirming(true);
    else void run(action);
  };

  return (
    <div className="mcp-install-row" aria-busy={pending || undefined}>
      <div className="mcp-install-row__head">
        <span className="mcp-install-row__name">{S.cliName[cli]}</span>
        <span className="mcp-install-row__status" title={errorCode}>
          {stateText}
          {detail && (
            <>
              {' '}
              <span className="mcp-install-row__detail">{detail}</span>
            </>
          )}
        </span>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {spoken}
        </span>
      </div>
      {showPath && (
        <span className="mcp-install-row__path" dir="ltr">
          {path}
        </span>
      )}
      {status?.user.shadowedBy && (
        <span className="mcp-install-row__note">{S.shadowed(status.user.shadowedBy)}</span>
      )}
      {cli === 'cursor' && <span className="mcp-install-row__note">{S.cursorNote}</span>}
      {status !== null && (
        <div className="mcp-install-row__actions" ref={actionsRef}>
          {retry && (
            <button
              type="button"
              className="btn btn--sm"
              aria-label={S.tryAgainAria(cli)}
              disabled={pending || checking}
              onClick={() => press(retry.action)}
            >
              {S.tryAgain}
            </button>
          )}
          {shown.map((b) => {
            const { text, aria } = label(b);
            return (
              <button
                key={text}
                type="button"
                className="btn btn--sm"
                aria-label={aria}
                disabled={pending || (checking && b.kind !== 'recheck')}
                // Disabling the focused Check again would drop focus to <body>.
                aria-disabled={checking && b.kind === 'recheck' ? true : undefined}
                onClick={() => press(actionOf(b))}
              >
                {text}
              </button>
            );
          })}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          state={{
            title: S.replaceTitle,
            message: S.replaceBody(path, `${path}${BACKUP_SUFFIX}`),
            confirmLabel: S.replaceConfirm,
            danger: true,
            focusCancel: true,
            onConfirm: () => void run('replace'),
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
