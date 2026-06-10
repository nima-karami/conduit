import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { FileContentDTO } from '../../src/protocol';
import { ensureTheme } from '../monaco-theme';

export function CodeViewer({ doc }: { doc: FileContentDTO }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const theme = ensureTheme();
    // Use a file:// model URI so the TS/JS language service recognises the file
    // (enables go-to-definition, hover, peek). Reuse an existing model if present.
    const uri = monaco.Uri.parse(`file:///${doc.path.replace(/^\/+/, '').replace(/\\/g, '/')}`);
    const existing = monaco.editor.getModel(uri);
    const model = existing ?? monaco.editor.createModel(doc.binary ? '' : doc.content, doc.language, uri);
    const editor = monaco.editor.create(ref.current, {
      model,
      theme,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    return () => { editor.dispose(); if (!existing) model.dispose(); };
  }, [doc.path, doc.content]);

  if (doc.binary) return <div className="viewer__notice">Binary file — no preview.</div>;
  return (
    <div className="viewer">
      {doc.truncated && <div className="viewer__banner">Large file — showing the first 2 MB.</div>}
      <div className="viewer__monaco" ref={ref} />
    </div>
  );
}
