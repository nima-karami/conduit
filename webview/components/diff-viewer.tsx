import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { langFromPath } from '../../src/lang';
import type { FileDiffDTO } from '../../src/protocol';
import { nextChange, prevChange } from '../diff-nav';
import { ensureTheme } from '../monaco-theme';
import { useSettings } from '../settings';
import { DiffControlsBar } from './diff-controls-bar';

export function DiffViewer({ doc }: { doc: FileDiffDTO }) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IDiffEditor | null>(null);
  const { settings, update } = useSettings();
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (!ref.current || doc.binary) return;
    const theme = ensureTheme();
    const language = langFromPath(doc.path);
    const editor = monaco.editor.createDiffEditor(ref.current, {
      theme,
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: settings.diffSideBySide,
      // Monaco defaults this to true, which silently overrides renderSideBySide below the
      // 900px breakpoint. False means the user's toggle is always respected.
      useInlineViewWhenSpaceIsLimited: false,
      minimap: { enabled: false },
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
    });
    editor.setModel({
      original: monaco.editor.createModel(doc.head, language),
      modified: monaco.editor.createModel(doc.work, language),
    });
    editorRef.current = editor;

    const changes = editor.getLineChanges();
    setHasChanges((changes?.length ?? 0) > 0);

    return () => {
      const m = editor.getModel();
      m?.original.dispose();
      m?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [doc.path, doc.head, doc.work, doc.binary, settings.diffSideBySide]);

  // Apply renderSideBySide changes live (see useInlineViewWhenSpaceIsLimited note above).
  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: settings.diffSideBySide,
      useInlineViewWhenSpaceIsLimited: false,
    });
  }, [settings.diffSideBySide]);

  const handleToggleSideBySide = () => {
    update({ diffSideBySide: !settings.diffSideBySide });
  };

  const navigateToChange = (finder: (lines: number[], current: number) => number) => {
    const editor = editorRef.current;
    if (!editor) return;
    const changes = editor.getLineChanges();
    if (!changes || changes.length === 0) return;
    const changeLines = changes.map((c) => c.modifiedStartLineNumber);
    const currentLine = editor.getModifiedEditor().getPosition()?.lineNumber ?? 1;
    const targetLine = finder(changeLines, currentLine);
    editor.getModifiedEditor().setPosition({ lineNumber: targetLine, column: 1 });
    editor.getModifiedEditor().revealLineInCenter(targetLine);
  };

  const handlePrevChange = () => navigateToChange(prevChange);
  const handleNextChange = () => navigateToChange(nextChange);

  if (doc.binary) return <div className="viewer__notice">Binary file — no diff preview.</div>;
  return (
    <div className="viewer">
      <DiffControlsBar
        sideBySide={settings.diffSideBySide}
        onToggleSideBySide={handleToggleSideBySide}
        onPrevChange={handlePrevChange}
        onNextChange={handleNextChange}
        hasChanges={hasChanges}
      />
      <div className="viewer__monaco" ref={ref} />
    </div>
  );
}
