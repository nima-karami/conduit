import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CursorConnectResult, CursorConnectState } from '../../src/conduit-mcp/cursor-config';
import { connectCursor, disconnectCursor, readCursorConnection } from '../bridge';
import { MCP_STR } from '../conduit-mcp-strings';

export function CursorConnectRow() {
  const [result, setResult] = useState<CursorConnectResult | null>(null);
  const [pending, setPending] = useState(true);
  const firstButton = useRef<HTMLButtonElement>(null);
  const shouldFocusAfterAction = useRef(false);

  useEffect(() => {
    let active = true;
    void readCursorConnection()
      .then(
        (current) => active && setResult(current),
        () => active && setResult({ state: 'error', path: '', errorCode: 'UNKNOWN' }),
      )
      .finally(() => active && setPending(false));
    return () => {
      active = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!pending && shouldFocusAfterAction.current) {
      firstButton.current?.focus();
      shouldFocusAfterAction.current = false;
    }
  }, [pending]);

  const run = async (action: () => Promise<CursorConnectResult>) => {
    shouldFocusAfterAction.current = true;
    setPending(true);
    try {
      setResult(await action());
    } catch {
      setResult({
        state: result?.state ?? 'error',
        path: result?.path ?? '',
        errorCode: 'UNKNOWN',
        actionFailed: true,
      });
    } finally {
      setPending(false);
    }
  };

  const state: CursorConnectState | 'pending' = pending ? 'pending' : (result?.state ?? 'error');
  const path = result?.path ?? '';
  const announcement = result?.actionFailed
    ? MCP_STR.cursorActionFailed(result.errorCode ?? 'UNKNOWN', MCP_STR.cursorState[result.state])
    : state === 'error'
      ? MCP_STR.cursorConfigError(result?.errorCode ?? 'UNKNOWN')
      : MCP_STR.cursorState[state];
  return (
    <div className="cursor-connect-row">
      <div
        className="cursor-connect-row__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span>{pending ? MCP_STR.cursorPending : announcement}</span>
        {!pending && path && (state === 'error' || result?.actionFailed) && (
          <span className="cursor-connect-row__path" dir="ltr">
            {path}
          </span>
        )}
      </div>
      <div className="cursor-connect-row__actions">
        {!result && pending ? (
          <button type="button" className="btn btn--sm" disabled>
            {MCP_STR.cursorPending}
          </button>
        ) : result?.state === 'error' ? (
          <button
            ref={firstButton}
            type="button"
            className="btn btn--sm"
            disabled={pending}
            onClick={() => void run(readCursorConnection)}
          >
            {MCP_STR.cursorCheckAgain}
          </button>
        ) : result?.state === 'connected' ? (
          <button
            ref={firstButton}
            type="button"
            className="btn btn--sm"
            aria-label={MCP_STR.cursorDisconnectAria}
            disabled={pending}
            onClick={() => void run(disconnectCursor)}
          >
            {MCP_STR.cursorDisconnect}
          </button>
        ) : (
          <>
            <button
              ref={firstButton}
              type="button"
              className="btn btn--sm"
              disabled={pending}
              onClick={() => void run(connectCursor)}
            >
              {MCP_STR.cursorConnect}
            </button>
            {result?.state === 'stale' && (
              <button
                type="button"
                className="btn btn--sm"
                aria-label={MCP_STR.cursorDisconnectAria}
                disabled={pending}
                onClick={() => void run(disconnectCursor)}
              >
                {MCP_STR.cursorDisconnect}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
