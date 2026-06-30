import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { FileContentDTO } from '../../src/protocol';
import { canSave, writeFile } from '../bridge';
import { getDirtySnapshot, updateDirty } from '../dirty-store';
import { buildEditorMenuItems, type EditorMenuIconKey } from '../editor-menu';
import { fontZoomTarget } from '../font-zoom';
import { IconCommand, IconCopy, IconDoc, IconGraph, IconSearch, IconSparkle } from '../icons';
import { sendMention } from '../mention-bus';
import { ensureTheme } from '../monaco-theme';
import { gotoInflight } from '../monaco-warmup';
import {
  fileUri,
  openDefinitionFile,
  publishCursor,
  setReveal,
  subscribeReveal,
  takeReveal,
} from '../project-index';
import { notifySaved, registerSave, type SaveEntry } from '../save-registry';
import { useSettings } from '../settings';
import { pushToast } from '../toast-store';
import { makeDebouncedFlush } from '../use-debounced-flush';
import { getViewState, setViewState, VIEW_STATE_DEBOUNCE_MS } from '../view-state-store';
import { ContextMenu, type MenuState } from './context-menu';
import { ImageViewer } from './image-viewer';

const MENU_ICONS: Record<EditorMenuIconKey, JSX.Element> = {
  copy: <IconCopy size={14} />,
  search: <IconSearch size={14} />,
  graph: <IconGraph size={14} />,
  command: <IconCommand size={14} />,
  doc: <IconDoc size={14} />,
  mention: <IconSparkle size={14} />,
};

/** TS/JS language ids whose worker backs go-to-definition. */
const TS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

/** Last path segment (for human-readable save messages). */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function CodeViewer({
  doc,
  viewStateId,
}: {
  doc: FileContentDTO;
  // Defaults to the `file:` doc id; the markdown "View source" toggle passes a distinct id so
  // its transient Monaco view state can't clobber the rendered-mode scroll under the same path.
  viewStateId?: string;
}) {
  const vsId = viewStateId ?? `file:${doc.path}`;
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // On-disk baseline (dirty = buffer !== baseline). In a ref so the mount-bound save
  // command and the change handler always see the latest value; advanced on save.
  const baselineRef = useRef(doc.content);
  baselineRef.current = doc.content;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [resolving, setResolving] = useState(false);
  const { settings, update } = useSettings();
  // In a ref so the mount-bound Alt+Z action toggles the current value without re-binding.
  const wordWrapRef = useRef(settings.wordWrap);
  wordWrapRef.current = settings.wordWrap;
  // Read at mount without becoming an effect dep (a dep would recreate the editor on
  // every zoom step). Live changes flow through updateOptions below.
  const editorFontRef = useRef(settings.editorFontSize);
  editorFontRef.current = settings.editorFontSize;

  useEffect(() => {
    if (!ref.current) return;
    const theme = ensureTheme();
    // file:// model URI so the TS/JS language service recognises the file
    // (enables go-to-definition, hover, peek). Reuse an existing model if present.
    const uri = fileUri(doc.path);
    const existing = monaco.editor.getModel(uri);
    const model =
      existing ?? monaco.editor.createModel(doc.binary ? '' : doc.content, doc.language, uri);
    // Re-seed a REUSED model so a clean re-open picks up fresh on-disk content (models
    // persist for cross-file go-to-definition, so a stale buffer would otherwise
    // survive — K3). NEVER re-seed a DIRTY model: it would destroy unsaved edits.
    if (existing && !doc.binary && !getDirtySnapshot().has(doc.path)) {
      if (existing.getValue() !== doc.content) existing.setValue(doc.content);
    }
    const editor = monaco.editor.create(ref.current, {
      model,
      theme,
      // Binary files render a notice instead, so this never exposes a writable
      // buffer for a non-text file.
      readOnly: false,
      automaticLayout: true,
      minimap: { enabled: false },
      // Suppress Monaco's own off-theme menu; onContextMenu below opens the app's shared one.
      contextmenu: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: editorFontRef.current,
      scrollBeyondLastLine: false,
      wordWrap: wordWrapRef.current ? 'on' : 'off',
      // Highlight only the line number, not a box outline around the active line's content.
      renderLineHighlight: 'gutter',
    });
    editorRef.current = editor;

    // Seed the dirty flag once now (the model may be reused with a buffer that already
    // differs from a freshly-loaded baseline), then recompute on every edit.
    const syncDirty = () => updateDirty(doc.path, baselineRef.current, model.getValue());
    syncDirty();
    const changeSub = model.onDidChangeContent(syncDirty);

    let saving = false;
    // Surface a save failure unmissably (banner + toast). A successful save toasts
    // NOTHING — the dot clearing is the only signal. K2: "it silently doesn't save".
    const fail = (reason: string) => {
      setSaveError(reason);
      pushToast({ message: `Could not save ${baseName(doc.path)}: ${reason}`, variant: 'error' });
    };
    // Returns true on success (or already clean), false on failure.
    const save = async (): Promise<boolean> => {
      if (saving) return false;
      const buffer = model.getValue();
      if (buffer === baselineRef.current) return true; // already clean — success
      if (!canSave) {
        fail('Saving is unavailable in the browser preview.');
        return false;
      }
      saving = true;
      setSaveError(null);
      try {
        const res = await writeFile(doc.path, buffer);
        if (res.ok) {
          baselineRef.current = buffer;
          updateDirty(doc.path, buffer, model.getValue());
          // Push saved content to app.tsx's files map so markdown viewers re-render
          // without a host round-trip (K3).
          notifySaved(doc.path, buffer);
          return true;
        } else {
          fail(res.error);
          return false;
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        saving = false;
      }
    };
    const revert = () => {
      model.setValue(baselineRef.current); // syncDirty fires via onDidChangeContent
    };
    // Register so the GLOBAL Mod+S handler (app.tsx) and the dirty-tab affordance can
    // save even when focus is outside the editor (K2). Monaco's own binding below also
    // calls this same self-guarded `save`, so a double-fire is a harmless no-op.
    const entry: SaveEntry = { save, revert };
    const unregisterSave = registerSave(doc.path, entry);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save();
    });
    // Also an action so Save shows in the command palette.
    editor.addAction({
      id: 'agentdeck.saveFile',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void save();
      },
    });

    // If we arrived via cross-file go-to-definition, reveal the target. An explicit reveal WINS
    // over saved-scroll restore (spec 2026-06-30 §3); only restore the saved view state otherwise.
    const pos = takeReveal(doc.path);
    if (pos) {
      editor.setPosition({ lineNumber: pos.line, column: pos.column });
      editor.revealLineInCenter(pos.line);
    } else {
      const saved = getViewState(vsId);
      if (saved?.kind === 'monaco' && saved.state) editor.restoreViewState(saved.state);
    }

    // Capture scroll+cursor+selection+folding via one saveViewState; debounced live + a sync
    // final capture on teardown (the safety net).
    const captureViewState = () => {
      const ed = editorRef.current;
      if (ed) setViewState(vsId, { kind: 'monaco', state: ed.saveViewState() });
    };
    const debouncedCapture = makeDebouncedFlush(captureViewState, VIEW_STATE_DEBOUNCE_MS);
    const scrollSub = editor.onDidScrollChange(() => debouncedCapture.schedule());

    // Worker-backed go-to-definition (the built-in editor action isn't reliably
    // bundled). Resolves in-file or, via the project models, across files.
    // `notify` surfaces a toast when an EXPLICIT lookup (F12 / menu) finds nothing, so a
    // miss (e.g. a symbol defined in node_modules, which isn't indexed) is honest instead
    // of a silent no-op. Ctrl+Click passes false — clicking off a symbol must stay quiet.
    const goToDefinition = async (notify = false) => {
      const mdl = editor.getModel();
      const p = editor.getPosition();
      if (!mdl || !p) return;
      if (!TS_LANGS.has(mdl.getLanguageId())) {
        if (notify)
          pushToast({
            message: 'Go to Definition is only available for JS/TS files.',
            variant: 'info',
          });
        return;
      }
      // end() in finally so a throw (cold worker, disposed model) can't leak the count.
      gotoInflight.begin();
      try {
        const getWorker = await monacoTs.getTypeScriptWorker();
        const worker = await getWorker(mdl.uri);
        const defs = await worker.getDefinitionAtPosition(mdl.uri.toString(), mdl.getOffsetAt(p));
        const d = defs?.[0];
        if (!d) {
          if (notify) pushToast({ message: 'No definition found.', variant: 'info' });
          return;
        }
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
        void goToDefinition(true);
      },
    });
    // Toggles the persisted setting; the live-apply effect below propagates the new
    // value to every open editor via updateOptions.
    editor.addAction({
      id: 'agentdeck.toggleWordWrap',
      label: 'Toggle Word Wrap',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
      run: () => update({ wordWrap: !wordWrapRef.current }),
    });
    // Right-click opens the app's shared context menu (Monaco's native one is
    // suppressed via `contextmenu: false`). The menu's "Go to Definition" routes to
    // our custom `agentdeck.goToDefinition` — the built-in TS one can't navigate
    // cross-file from a standalone editor.
    const ctxSub = editor.onContextMenu((e) => {
      e.event.preventDefault();
      const mdl = editor.getModel();
      const sel = editor.getSelection();
      const hasSelection = !!sel && !sel.isEmpty();
      const canGoToDefinition = !!mdl && TS_LANGS.has(mdl.getLanguageId());
      const specs = buildEditorMenuItems({ readOnly: false, hasSelection, canGoToDefinition });
      // Viewport coords for the fixed-position menu; posx/posy are page-based and would drift.
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
              // Read at click-time (not the build-time closure) so Copy reflects the live selection.
              const range = editor.getSelection();
              const text = range ? (editor.getModel()?.getValueInRange(range) ?? '') : '';
              void navigator.clipboard?.writeText(text);
            } else if (s.action.kind === 'mention') {
              const range = editor.getSelection();
              if (range) {
                sendMention({
                  path: doc.path,
                  startLine: range.startLineNumber,
                  endLine: range.endLineNumber,
                });
              }
            } else {
              void editor.getAction(s.action.actionId)?.run();
            }
          },
        })),
      });
    });
    // Ctrl/Cmd+Click also navigates to definition.
    const mouseSub = editor.onMouseDown((e) => {
      if ((e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        editor.setPosition(e.target.position);
        void goToDefinition();
      }
    });

    // Drive the breadcrumb bar's cursor position (E3).
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      const mdl = editor.getModel();
      if (!mdl) return;
      publishCursor({ path: doc.path, offset: mdl.getOffsetAt(e.position) });
    });
    // Seed it once so the breadcrumb populates immediately.
    const initPos = editor.getPosition();
    if (initPos && model) publishCursor({ path: doc.path, offset: model.getOffsetAt(initPos) });

    // Don't dispose models we keep for cross-file resolution; only dispose the editor.
    return () => {
      debouncedCapture.cancel();
      captureViewState(); // sync final capture BEFORE dispose, else saveViewState has no editor
      unregisterSave();
      changeSub.dispose();
      scrollSub.dispose();
      mouseSub.dispose();
      ctxSub.dispose();
      cursorSub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [doc.path, doc.content, doc.language, doc.binary, update, vsId]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: settings.wordWrap ? 'on' : 'off' });
  }, [settings.wordWrap]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: settings.editorFontSize });
  }, [settings.editorFontSize]);

  // Live reveal for an ALREADY-open doc: the onMount reveal won't re-run, so consume
  // the staged target here and center it. New-tab opens go through the onMount path.
  useEffect(() => {
    return subscribeReveal((path) => {
      const ed = editorRef.current;
      if (!ed) return;
      const k = doc.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (path !== k) return;
      const pos = takeReveal(doc.path);
      if (!pos) return;
      ed.setPosition({ lineNumber: pos.line, column: pos.column });
      ed.revealLineInCenter(pos.line);
      ed.focus();
    });
  }, [doc.path]);

  // Drive the loading indicator so a slow (cold-worker) go-to-definition shows
  // progress instead of a frozen editor (E1).
  useEffect(() => {
    const sync = () => setResolving(gotoInflight.active());
    sync();
    return gotoInflight.subscribe(sync);
  }, []);

  // Re-theme on code-block colour/opacity change (wishlist C3). Pass settings values
  // straight into ensureTheme rather than reading the CSS vars, so this can't lag a
  // render behind the provider's applyToDom effect (which runs after this child effect).
  useEffect(() => {
    if (!editorRef.current) return;
    monaco.editor.setTheme(
      ensureTheme({ surfaceColor: settings.surfaceColor, codeOpacity: settings.codeOpacity }),
    );
  }, [settings.surfaceColor, settings.codeOpacity]);

  // Image files (including SVG) bypass Monaco — ImageViewer handles them.
  if (doc.image || (doc.binary && doc.error?.includes('too large')))
    return <ImageViewer doc={doc} />;
  if (doc.binary) return <div className="viewer__notice">Binary file — no preview.</div>;
  return (
    <div
      className="viewer"
      data-resolving={resolving || undefined}
      // Capture phase intercepts Ctrl/Cmd +/-/0 zoom before Monaco's keybinding service.
      onKeyDownCapture={(e) => {
        const zoom = fontZoomTarget(settings.editorFontSize, e);
        if (zoom !== null) {
          e.preventDefault();
          e.stopPropagation();
          update({ editorFontSize: zoom });
        }
      }}
    >
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
