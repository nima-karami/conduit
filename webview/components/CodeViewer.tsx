import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import type { FileContentDTO } from '../../src/protocol';
import { ensureTheme } from '../monaco-theme';
import { fileUri, takeReveal, setReveal, openDefinitionFile } from '../projectIndex';

export function CodeViewer({ doc }: { doc: FileContentDTO }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const theme = ensureTheme();
    // Use a file:// model URI so the TS/JS language service recognises the file
    // (enables go-to-definition, hover, peek). Reuse an existing model if present.
    const uri = fileUri(doc.path);
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
    // If we navigated here via cross-file go-to-definition, reveal the target.
    const pos = takeReveal(doc.path);
    if (pos) {
      editor.setPosition({ lineNumber: pos.line, column: pos.column });
      editor.revealLineInCenter(pos.line);
    }

    // Worker-backed go-to-definition (the built-in editor action isn't reliably
    // bundled). Resolves in-file or, via the project models, across files.
    const goToDefinition = async () => {
      const mdl = editor.getModel();
      const p = editor.getPosition();
      if (!mdl || !p) return;
      try {
        const getWorker = await monacoTs.getTypeScriptWorker();
        const worker = await getWorker(mdl.uri);
        const defs = await worker.getDefinitionAtPosition(mdl.uri.toString(), mdl.getOffsetAt(p));
        const d = defs?.[0];
        if (!d) return;
        const targetUri = monaco.Uri.parse(d.fileName);
        if (targetUri.toString() === mdl.uri.toString()) {
          const tp = mdl.getPositionAt(d.textSpan.start);
          editor.setPosition(tp);
          editor.revealLineInCenter(tp.lineNumber);
        } else {
          const target = monaco.editor.getModel(targetUri);
          const tp = target ? target.getPositionAt(d.textSpan.start) : { lineNumber: 1, column: 1 };
          const abs = targetUri.path.replace(/^\/+/, '');
          setReveal(abs, { line: tp.lineNumber, column: tp.column });
          openDefinitionFile(abs);
        }
      } catch { /* worker not ready / non-TS file */ }
    };
    editor.addAction({
      id: 'agentdeck.goToDefinition',
      label: 'Go to Definition',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => { void goToDefinition(); },
    });
    // Monaco's TS language features also contribute a "Go to Definition" item, but
    // a standalone editor can't open other models, so it can't navigate cross-file.
    // Hide those built-in items so only our worker-backed action remains (one entry
    // that handles both in-file and cross-file via the tab system).
    const HIDDEN_MENU_IDS = new Set([
      'editor.action.revealDefinition',
      'editor.action.revealDefinitionAside',
      'editor.action.goToDeclaration',
      'editor.action.peekDefinition',
    ]);
    type CtxMenu = { _getMenuActions?: (...a: unknown[]) => unknown };
    const ctxMenu = editor.getContribution('editor.contrib.contextmenu') as CtxMenu | null;
    if (ctxMenu && typeof ctxMenu._getMenuActions === 'function') {
      const orig = ctxMenu._getMenuActions.bind(ctxMenu);
      ctxMenu._getMenuActions = (...args: unknown[]) => {
        const actions = orig(...args);
        return Array.isArray(actions)
          ? actions.filter((a) => !HIDDEN_MENU_IDS.has((a as { id?: string })?.id ?? ''))
          : actions;
      };
    }
    // Ctrl/Cmd+Click also navigates.
    const mouseSub = editor.onMouseDown((e) => {
      if ((e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        editor.setPosition(e.target.position);
        void goToDefinition();
      }
    });

    // Don't dispose models we keep for cross-file resolution; only dispose the editor.
    return () => { mouseSub.dispose(); editor.dispose(); };
  }, [doc.path, doc.content]);

  if (doc.binary) return <div className="viewer__notice">Binary file — no preview.</div>;
  return (
    <div className="viewer">
      {doc.truncated && <div className="viewer__banner">Large file — showing the first 2 MB.</div>}
      <div className="viewer__monaco" ref={ref} />
    </div>
  );
}
