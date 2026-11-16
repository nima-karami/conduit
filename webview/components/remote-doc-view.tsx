import { useEffect, useState } from 'react';
import { tabStateKey, useEditorGroup } from '../editor-group-context';
import { MACHINES_STR } from '../machines-strings';
import { loadRemoteDoc, type RemoteFileDoc, useRemoteFile } from '../remote-files-store';
import { CodeViewer } from './code-viewer';
import { PdfViewer } from './pdf-viewer';

/**
 * A remote file tab. Its text comes from the machine through the remote store, never the local
 * file cache, so it renders on its own: the same viewers as a local file, but none of the local
 * file's state (see CodeViewer's `source`). Markdown and HTML show as source here, because their
 * rendered forms resolve links and images against local paths.
 *
 * The read is fixed to the doc this view was mounted with: a different doc is a different tab and
 * the caller keys the view by doc id, so a re-render with a new doc object never re-reads.
 */
export function RemoteDocView({ doc, machineName }: { doc: RemoteFileDoc; machineName: string }) {
  const group = useEditorGroup();
  const stateKey = tabStateKey(doc.id, group);
  const [target] = useState(doc);
  useEffect(() => loadRemoteDoc(target), [target]);
  const file = useRemoteFile(target.id);

  if (!file) return <div className="viewer__notice">{MACHINES_STR.filesLoading}</div>;
  if (file.error) return <div className="viewer__notice">{MACHINES_STR.fileError(file.error)}</div>;
  if (file.pdf) return <PdfViewer doc={file} focusKey={stateKey} />;
  return (
    <CodeViewer
      doc={file}
      viewStateId={stateKey}
      source={{ kind: 'remote', machineId: target.machine.machineId, machineName }}
    />
  );
}
