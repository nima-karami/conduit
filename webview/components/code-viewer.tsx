import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { FileContentDTO } from '../../src/protocol';
import { canSave, writeFile } from '../bridge';
import { updateDirty } from '../dirty-store';
import { buildEditorMenuItems, type EditorMenuIconKey } from '../editor-menu';
import { IconCommand, IconCopy, IconDoc, IconGraph, IconSearch } from '../icons';
import { ensureTheme } from '../monaco-theme';
import { gotoInflight } from '../monaco-warmup';
import { fileUri, openDefinitionFile, setReveal, takeReveal } from '../project-index';
import { registerSave } from '../save-registry';
import { useSettings } from '../settings';
import { pushToast } from '../toast-store';
import { ContextMenu, type MenuState } from './context-menu';

const MENU_ICONS: Record<EditorMenuIconKey, JSX.Element> = {
  copy: <IconCopy size={14} />,
  search: <IconSearch size={14} />,
  graph: <IconGraph size={14} />,
  command: <IconCommand size={14} />,
  doc: <IconDoc size={14} />,
};

/** TS/JS language ids whose worker backs go-to-definition. */
const TS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

/** Last path segment (for human-readable save messages). */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function CodeViewer({ doc }: { doc: FileContentDTO }) {
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The on-disk baseline for the open file. Dirty = buffer !== baseline. Updated on
  // a successful save so the dot clears; held in a ref so the save command (bound
  // once at mount) and the content-change handler always see the latest value.
  const baselineRef = useRef(doc.content);
  baselineRef.current = doc.content;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Reflects the shared in-flight tracker: true while ≥1 go-to-definition is resolving.
  const [resolving, setResolving] = useState(false);
  const { settings, update } = useSettings();
  // Keep the latest wrap value in a ref so the Alt+Z action (bound once at mount)
  // always toggles against the current setting without re-binding on every change.
  const wordWrapRef = useRef(settings.wordWrap);
  wordWrapRef.current = settings.wordWrap;

  useEffect(() => {
    if (!ref.current) return;
    const theme = ensureTheme();
    // Use a file:// model URI so the TS/JS language service recognises the file
    // (enables go-to-definition, hover, peek). Reuse an existing model if present.
    const uri = fileUri(doc.path);
    const existing = monaco.editor.getModel(uri);
    const model =
      existing ?? monaco.editor.createModel(doc.binary ? '' : doc.content, doc.language, uri);
    const editor = monaco.editor.create(ref.current, {
      model,
      theme,
      // Editable (I2). Binary files render a notice instead of this editor, so we
      // never expose a writable buffer for a non-text file.
      readOnly: false,
      automaticLayout: true,
      minimap: { enabled: false },
      // Suppress Monaco's own (off-theme) menu; we open the app's shared menu
      // from onContextMenu below so the editor matches the rest of the app.
      contextmenu: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      scrollBeyondLastLine: false,
      wordWrap: wordWrapRef.current ? 'on' : 'off',
    });
    editorRef.current = editor;

    // ---- Dirty tracking (I2) ----------------------------------------------
    // Recompute this file's dirty flag (buffer vs on-disk baseline) on every edit
    // and seed it once now (the model may be reused from a previous mount, so its
    // buffer can already differ from a freshly-loaded baseline).
    const syncDirty = () => updateDirty(doc.path, baselineRef.current, model.getValue());
    syncDirty();
    const changeSub = model.onDidChangeContent(syncDirty);

    // ---- Save (Ctrl/Cmd+S) -------------------------------------------------
    // Writes the buffer back to the exact file it was opened from, via the host
    // writeFile bridge. On success we advance the baseline (clearing the dot); on a
    // rejection/error (or no host in the preview) we KEEP the buffer dirty and show
    // the reason — a failed write must never look saved. Guarded so it never throws.
    let saving = false;
    // Surface a save failure unmissably: keep the in-editor banner AND raise a toast
    // (silence = success — a successful save toasts NOTHING; the dot clearing is the
    // signal). This is the "it silently doesn't save" half of the bug (K2).
    const fail = (reason: string) => {
      setSaveError(reason);
      pushToast({ message: `Could not save ${baseName(doc.path)}: ${reason}`, variant: 'error' });
    };
    const save = async () => {
      if (saving) return;
      const buffer = model.getValue();
      if (buffer === baselineRef.current) return; // nothing to save (already clean)
      if (!canSave) {
        // Browser preview: no filesystem. Safe no-op — surface why, keep it dirty.
        fail('Saving is unavailable in the browser preview.');
        return;
      }
      saving = true;
      setSaveError(null);
      try {
        const res = await writeFile(doc.path, buffer);
        if (res.ok) {
          baselineRef.current = buffer;
          updateDirty(doc.path, buffer, model.getValue());
        } else {
          fail(res.error);
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      } finally {
        saving = false;
      }
    };
    // Register this doc's save so the GLOBAL Mod+S handler (app.tsx) and the dirty-tab
    // affordance can trigger it even when focus is outside the editor (K2). Monaco's own
    // binding below still handles Ctrl+S when the editor is focused; both call this same
    // self-guarded `save`, so a double-fire is a harmless no-op.
    const unregisterSave = registerSave(doc.path, {
      save: () => {
        void save();
      },
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save();
    });
    // Also expose Save as an action so it shows in the command palette.
    editor.addAction({
      id: 'agentdeck.saveFile',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void save();
      },
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
      // Mark the request in-flight so the loading indicator shows. end() is in a
      // finally so a throw (cold worker, disposed model) can never leak the count.
      gotoInflight.begin();
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
      } catch {
        /* worker not ready / non-TS file */
      } finally {
        gotoInflight.end();
      }
    };
    editor.addAction({
      id: 'agentdeck.goToDefinition',
      label: 'Go to Definition',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => {
        void goToDefinition();
      },
    });
    // Word wrap toggle — standard Alt+Z. Registered as an action so it also shows in
    // Monaco's command palette. Toggles the persisted setting; the live-apply effect
    // below propagates the new value to every open editor via updateOptions.
    editor.addAction({
      id: 'agentdeck.toggleWordWrap',
      label: 'Toggle Word Wrap',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
      run: () => update({ wordWrap: !wordWrapRef.current }),
    });
    // Right-click opens the app's shared context menu (Monaco's native one is
    // suppressed via `contextmenu: false`). We build a context-aware item list
    // and wire each entry back to the corresponding editor action. The TS
    // language service still contributes a built-in "Go to Definition", but a
    // standalone editor can't navigate cross-file with it — our custom
    // `agentdeck.goToDefinition` (in the menu) handles both in-file and
    // cross-file via the tab system.
    const ctxSub = editor.onContextMenu((e) => {
      e.event.preventDefault();
      const mdl = editor.getModel();
      const sel = editor.getSelection();
      const hasSelection = !!sel && !sel.isEmpty();
      const canGoToDefinition = !!mdl && TS_LANGS.has(mdl.getLanguageId());
      const specs = buildEditorMenuItems({ readOnly: false, hasSelection, canGoToDefinition });
      // Viewport coords for the fixed-position menu (match other consumers'
      // clientX/clientY); posx/posy are page-based and would drift if scrolled.
      setMenu({
        x: e.event.browserEvent.clientX,
        y: e.event.browserEvent.clientY,
        items: specs.map((s) => ({
          label: s.label,
          icon: s.iconKey ? MENU_ICONS[s.iconKey] : undefined,
          disabled: s.disabled,
          separatorBefore: s.separatorBefore,
          onClick: () => {
            editor.focus();
            if (s.action.kind === 'copy') {
              // Read selection + model at click-time (not from the build-time
              // closure) so Copy reflects the live selection.
              const range = editor.getSelection();
              const text = range ? (editor.getModel()?.getValueInRange(range) ?? '') : '';
              void navigator.clipboard?.writeText(text);
            } else {
              void editor.getAction(s.action.actionId)?.run();
            }
          },
        })),
      });
    });
    // Ctrl/Cmd+Click also navigates.
    const mouseSub = editor.onMouseDown((e) => {
      if ((e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        editor.setPosition(e.target.position);
        void goToDefinition();
      }
    });

    // Don't dispose models we keep for cross-file resolution; only dispose the editor.
    return () => {
      unregisterSave();
      changeSub.dispose();
      mouseSub.dispose();
      ctxSub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [doc.path, doc.content, doc.language, doc.binary, update]);

  // Apply the word-wrap preference live to the open editor (Alt+Z, Settings toggle,
  // or a value pushed by another mounted editor all flow through here).
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: settings.wordWrap ? 'on' : 'off' });
  }, [settings.wordWrap]);

  // Drive the loading indicator from the shared in-flight tracker so a possibly-slow
  // (cold-worker) go-to-definition shows progress instead of a frozen editor (E1).
  useEffect(() => {
    const sync = () => setResolving(gotoInflight.active());
    sync();
    return gotoInflight.subscribe(sync);
  }, []);

  // Re-apply the editor theme when the code-block colour/opacity change so an already
  // open editor picks up the new translucent background live (wishlist C3). We pass the
  // settings values straight into ensureTheme rather than reading the CSS vars, so this
  // can't lag a render behind the provider's applyToDom effect (which runs after this
  // child effect on the same commit). setTheme then repaints every open editor.
  useEffect(() => {
    if (!editorRef.current) return;
    monaco.editor.setTheme(
      ensureTheme({ surfaceColor: settings.surfaceColor, codeOpacity: settings.codeOpacity }),
    );
  }, [settings.surfaceColor, settings.codeOpacity]);

  if (doc.binary) return <div className="viewer__notice">Binary file — no preview.</div>;
  return (
    <div className="viewer" data-resolving={resolving || undefined}>
      {doc.truncated && <div className="viewer__banner">Large file — showing the first 2 MB.</div>}
      {saveError && (
        <div className="viewer__banner viewer__banner--error" role="alert">
          Could not save: {saveError}
        </div>
      )}
      <div className="viewer__monaco" ref={ref} />
      {resolving && (
        <div className="viewer__loading" role="status" aria-live="polite">
          Resolving definition…
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
