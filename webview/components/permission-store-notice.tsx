import { useState } from 'react';
import type { PolicyEditResult } from '../../src/conduit-mcp/policy-types';

export interface PermissionStoreNoticeProps {
  saveError: string | null;
  backupWarning: string | null;
  readOnly: boolean;
  onRetry(): Promise<PolicyEditResult | null>;
}

export function PermissionStoreNotice(props: PermissionStoreNoticeProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!props.saveError && !props.backupWarning && !props.readOnly && !failure && !pending)
    return null;
  const retry = async () => {
    setPending(true);
    setFailure(null);
    try {
      const result = await props.onRetry();
      if (result === null)
        setFailure('Saving timed out. The current permissions may not be saved.');
      else if (!result.ok) setFailure(`Permissions could not be saved (${result.error}).`);
    } catch (error) {
      setFailure(
        `Permissions could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="permission-store-notice" role="status">
      {props.saveError && <p>{props.saveError}</p>}
      {props.readOnly && (
        <p>
          The permissions store is read-only. Restrictions remain active here; saving is
          unavailable.
        </p>
      )}
      {props.backupWarning && <p>Permissions backup: {props.backupWarning}</p>}
      {failure && <p>{failure}</p>}
      <button type="button" className="btn" disabled={pending || props.readOnly} onClick={retry}>
        {pending ? 'Saving…' : 'Retry saving current rules'}
      </button>
    </div>
  );
}
