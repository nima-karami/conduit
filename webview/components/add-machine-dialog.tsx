import { useEffect, useId, useRef, useState } from 'react';
import type { MachineActionResult, MachineErrorCode } from '../../src/contracts/machines';
import { logToHost } from '../bridge';
import { MACHINES_STR } from '../machines-strings';
import { ModalLayer } from './modal-layer';

/** Where the last attempt stopped: a needs-person prompt the owner answers in a terminal, or a fault. */
type Fault =
  | { kind: 'needs'; target: string; reason: string }
  | { kind: 'error'; code: MachineErrorCode };

/**
 * Add a machine (docs/specs/2026-11-16-remote-ssh.md §9.1, §9.2). Hosts from the ssh config fill
 * the field and submit; a typed target does the same. Esc and the scrim close it through the
 * overlay stack, which is why this has no key handler of its own.
 */
export function AddMachineDialog({
  hosts,
  onSubmit,
  onOpenNeedsPerson,
  onClose,
}: {
  hosts: readonly string[];
  onSubmit: (machine: string) => Promise<MachineActionResult>;
  onOpenNeedsPerson: (target: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const hostsId = useId();
  const fieldId = useId();
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [fault, setFault] = useState<Fault | null>(null);
  // A ref, not the pending state: a second click in the same tick must not dial again.
  const busyRef = useRef(false);
  const lastRef = useRef<string | null>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  // Dialing has ended with a fault: focus its first action, so the next key lands on it.
  useEffect(() => {
    if (pending === null && fault !== null) firstActionRef.current?.focus();
  }, [pending, fault]);

  const submit = async (raw: string) => {
    const machine = raw.trim();
    if (machine === '' || busyRef.current) return;
    busyRef.current = true;
    lastRef.current = machine;
    setTarget(machine);
    setPending(machine);
    setFault(null);
    try {
      const result = await onSubmit(machine);
      if (result.ok) {
        onClose();
        return;
      }
      const { error } = result;
      setFault(
        error.code === 'ssh_needs_person'
          ? { kind: 'needs', target: machine, reason: error.detail.reason ?? '' }
          : { kind: 'error', code: error.code },
      );
    } catch (error) {
      logToHost('add machine: the connect request failed', {
        level: 'warn',
        scope: 'machines',
        data: { error: String(error) },
      });
      // The request itself failed (the link or the server went away): the owner sees the same
      // line as an unreachable machine, and can retry.
      setFault({ kind: 'error', code: 'ssh_unreachable' });
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  };

  const retry = () => {
    const last = lastRef.current;
    if (last !== null) void submit(last);
  };

  // One polite region carries the progress and any fault, so both are announced.
  const message =
    pending !== null
      ? MACHINES_STR.dialing(pending)
      : fault === null
        ? ''
        : fault.kind === 'needs'
          ? MACHINES_STR.needsYou(fault.target, fault.reason)
          : MACHINES_STR.error(fault.code);

  return (
    <ModalLayer onDismiss={onClose}>
      <div
        className="modal machine-dialog"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <span id={titleId} className="modal__title modal__title--compact">
            {MACHINES_STR.addTitle}
          </span>
        </div>
        <div className="modal__body">
          <span id={hostsId} className="machine-dialog__label">
            {MACHINES_STR.hostsLabel}
          </span>
          {hosts.length > 0 ? (
            <div className="machine-dialog__hosts" role="group" aria-labelledby={hostsId}>
              {hosts.map((host) => (
                <button
                  key={host}
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void submit(host)}
                >
                  {host}
                </button>
              ))}
            </div>
          ) : (
            <p className="machine-dialog__none">{MACHINES_STR.noHosts}</p>
          )}
          <form
            className="machine-dialog__form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(target);
            }}
          >
            <label htmlFor={fieldId} className="machine-dialog__label">
              {MACHINES_STR.targetLabel}
            </label>
            <input
              id={fieldId}
              className="modal__input"
              autoFocus
              value={target}
              placeholder={MACHINES_STR.targetPlaceholder}
              onChange={(e) => setTarget(e.target.value)}
            />
            <div className="modal__actions">
              <button type="button" className="btn" onClick={onClose}>
                {MACHINES_STR.cancel}
              </button>
              <button type="submit" className="btn btn--primary" disabled={target.trim() === ''}>
                {MACHINES_STR.connect}
              </button>
            </div>
          </form>
          <p
            className={`machine-dialog__progress${fault !== null && pending === null ? ' modal__error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {message}
          </p>
          {fault?.kind === 'needs' && (
            <div className="machine-dialog__fault">
              <p className="machine-dialog__hint">{MACHINES_STR.needsPersonHint}</p>
              <div className="modal__actions">
                <button
                  ref={firstActionRef}
                  type="button"
                  className="btn"
                  onClick={() => onOpenNeedsPerson(fault.target)}
                >
                  {MACHINES_STR.connectInTerminal}
                </button>
                <button type="button" className="btn" onClick={retry}>
                  {MACHINES_STR.retry}
                </button>
              </div>
            </div>
          )}
          {fault?.kind === 'error' && (
            <div className="modal__actions">
              <button ref={firstActionRef} type="button" className="btn" onClick={retry}>
                {MACHINES_STR.retry}
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}
