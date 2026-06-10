import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { FileContentDTO } from '../../src/protocol';
import { ensureTheme } from '../monaco-theme';

export function CodeViewer({ doc }: { doc: FileContentDTO }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const theme = ensureTheme();
    const editor = monaco.editor.create(ref.current, {
      value: doc.binary ? '' : doc.content,
      language: doc.language,
      theme,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    return () => editor.dispose();
  }, [doc.path, doc.content]);

  if (doc.binary) return <div className="viewer__notice">Binary file — no preview.</div>;
  return (
    <div className="viewer">
      {doc.truncated && <div className="viewer__banner">Large file — showing the first 2 MB.</div>}
      <div className="viewer__monaco" ref={ref} />
    </div>
  );
}
