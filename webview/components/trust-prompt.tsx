// The Workspace Trust question, in the editor area — non-modal, so editing carries on while it
// waits. The host raised it and owns the answer; this only reports which button was pressed, by
// the host's prompt id (docs/specs/2026-09-23-workspace-trust.md §3–§4).
import { useEffect, useRef } from 'react';
import type { LspTrustChoice } from '../../src/lsp-protocol';
import { lspInvoke } from '../bridge';
import { setTrustFocusTarget, useLspTrust, useTrustFocusTarget } from '../lsp-status';

export function TrustPrompt() {
  const { prompt } = useLspTrust();
  // A prompt that appears unasked (a server wanted to start) must not pull the caret out of the
  // editor; only the prompt the user asked for takes focus, once.
  const focusTarget = useTrustFocusTarget();
  const trustRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!prompt || prompt.id !== focusTarget || !trustRef.current) return;
    trustRef.current.focus();
    setTrustFocusTarget(null);
  }, [prompt, focusTarget]);

  if (!prompt) return null;
  const answer = (choice: LspTrustChoice) =>
    void lspInvoke({ type: 'lsp:trustAnswer', promptId: prompt.id, choice });
  const titleId = `trust-title-${prompt.id}`;
  return (
    <section
      className="trust-prompt"
      role="dialog"
      aria-modal="false"
      aria-live="polite"
      aria-labelledby={titleId}
    >
      <div className="trust-prompt__body">
        <h2 id={titleId} className="trust-prompt__title">
          Do you trust the authors of the files in this folder?
        </h2>
        <p className="trust-prompt__folder">{prompt.folder}</p>
        <p className="trust-prompt__why">
          {prompt.displayName} navigation runs tools from this project ({prompt.runsTools}).
        </p>
      </div>
      <div className="trust-prompt__actions">
        <button
          ref={trustRef}
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => answer('trust')}
        >
          Trust
        </button>
        {/* The host offers no parent when it would be a drive root or the home folder. */}
        {prompt.parent && (
          <button
            type="button"
            className="btn trust-prompt__parent"
            onClick={() => answer('trustParent')}
          >
            Trust Parent Folder: <span className="trust-prompt__path">{prompt.parent}</span>
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm"
          title="Stay in Restricted Mode: no language server runs here"
          onClick={() => answer('deny')}
        >
          Don’t Trust
        </button>
      </div>
    </section>
  );
}
