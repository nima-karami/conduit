import { useId, useRef, useState } from 'react';
import type { MachineActionResult, MachineErrorCode } from '../../src/contracts/machines';
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
  const lastRef = useRef<string | null>(null);

  const submit = async (raw: string) => {
    const machine = raw.trim();
    if (machine === '' || pending !== null) return;
    lastRef.current = machine;
    setTarget(machine);
    setPending(machine);
    setFault(null);
    const result = await onSubmit(machine);
    setPending(null);
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
  };

  const retry = () => {
    const last = lastRef.current;
    if (last !== null) void submit(last);
  };

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
                  disabled={pending !== null}
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
              disabled={pending !== null}
              onChange={(e) => setTarget(e.target.value)}
            />
            <div className="modal__actions">
              <button type="button" className="btn" onClick={onClose}>
                {MACHINES_STR.cancel}
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={pending !== null || target.trim() === ''}
              >
                {MACHINES_STR.connect}
              </button>
            </div>
          </form>
          <p className="machine-dialog__progress" role="status" aria-live="polite">
            {pending !== null ? MACHINES_STR.dialing(pending) : ''}
          </p>
          {fault?.kind === 'needs' && (
            <div className="machine-dialog__fault">
              <p className="modal__error">{MACHINES_STR.needsYou(fault.target, fault.reason)}</p>
              <p className="machine-dialog__hint">{MACHINES_STR.needsPersonHint}</p>
              <div className="modal__actions">
                <button
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
            <div className="machine-dialog__fault">
              <p className="modal__error">{MACHINES_STR.error(fault.code)}</p>
              <div className="modal__actions">
                <button type="button" className="btn" onClick={retry}>
                  {MACHINES_STR.retry}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}
