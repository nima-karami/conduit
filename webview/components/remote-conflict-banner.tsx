import { useState } from 'react';
import type { WriteConflict } from '../../src/path-guard';
import { IconWarning } from '../icons';
import { MACHINES_STR } from '../machines-strings';
import { readRemoteCurrent, reapplyRemote, remoteFileSaves } from '../remote-file-saves';
import { DiffViewer } from './diff-viewer';

/**
 * B refused a save because its file is no longer what this editor loaded (RS-D17 a, plan CON-44
 * decision 6). The owner sees B's text against the edit before choosing: Re-apply overwrites
 * exactly the version shown, Discard takes B's file.
 */
export function RemoteConflictBanner({
  bufferKey,
  path,
  machineName,
  conflict,
  bufferText,
}: {
  bufferKey: string;
  path: string;
  machineName: string;
  conflict: WriteConflict;
  /** The edit as it stands, read when the diff opens. */
  bufferText: () => string;
}) {
  // undefined: diff closed; null: B's text could not be read; string: B's text now.
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const showDiff = async () => {
    setLoading(true);
    const text = conflict === 'deleted' ? '' : await readRemoteCurrent(bufferKey);
    setLoading(false);
    setCurrent(text);
  };

  return (
    <>
      <div className="viewer__banner viewer__banner--warn" role="alert">
        <IconWarning size={14} />
        <span>
          {conflict === 'deleted'
            ? MACHINES_STR.remoteFileDeleted(machineName)
            : MACHINES_STR.remoteFileChanged(machineName)}
        </span>
        <div className="viewer__banner-actions">
          {current === undefined ? (
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => void showDiff()}
            >
              {MACHINES_STR.remoteConflictShowDiff}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setCurrent(undefined)}>
              {MACHINES_STR.remoteConflictHideDiff}
            </button>
          )}
          <button type="button" className="btn" onClick={() => void reapplyRemote(bufferKey)}>
            {MACHINES_STR.remoteConflictReapply}
          </button>
          <button type="button" className="btn" onClick={() => remoteFileSaves.reload(bufferKey)}>
            {MACHINES_STR.remoteConflictDiscard(machineName)}
          </button>
        </div>
      </div>
      {current === null && (
        <div className="viewer__banner viewer__banner--error" role="alert">
          {MACHINES_STR.remoteFileReloadFailed(machineName)}
        </div>
      )}
      {typeof current === 'string' && (
        <div className="remote-conflict__diff">
          <DiffViewer doc={{ path, head: current, work: bufferText(), binary: false }} />
        </div>
      )}
    </>
  );
}
