import * as monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';
import { langFromPath } from '../../src/lang';
import type { FileDiffDTO } from '../../src/protocol';
import { ensureTheme } from '../monaco-theme';

export function DiffViewer({ doc }: { doc: FileDiffDTO }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || doc.binary) return;
    const theme = ensureTheme();
    const language = langFromPath(doc.path);
    const editor = monaco.editor.createDiffEditor(ref.current, {
      theme,
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
    });
    editor.setModel({
      original: monaco.editor.createModel(doc.head, language),
      modified: monaco.editor.createModel(doc.work, language),
    });
    return () => {
      const m = editor.getModel();
      m?.original.dispose();
      m?.modified.dispose();
      editor.dispose();
    };
  }, [doc.path, doc.head, doc.work, doc.binary]);

  if (doc.binary) return <div className="viewer__notice">Binary file — no diff preview.</div>;
  return (
    <div className="viewer">
      <div className="viewer__monaco" ref={ref} />
    </div>
  );
}
